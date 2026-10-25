import React, { createContext, useContext, useReducer, useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'react-toastify';
import { comboService } from '../services/api';
import { useSession } from '../lib/auth-client';
import {
	DEFAULT_STOREFRONT_ID,
	clearPrivateCarts,
	loadCart,
	migrateLegacyCart,
	normalizeStorefront,
	readActiveStorefront,
	sameStorefront,
	saveCart,
	writeActiveStorefront
} from '../lib/cart-storage';

// Cart Context
const CartContext = createContext();

// The +/- controls stop at this ceiling, so adds must too or a line could exceed what they reach.
export const CART_MAX_QUANTITY = 99;

// Cart Actions
const CART_ACTIONS = {
	ADD_ITEM: 'ADD_ITEM',
	REMOVE_ITEM: 'REMOVE_ITEM',
	UPDATE_QUANTITY: 'UPDATE_QUANTITY',
	CLEAR_CART: 'CLEAR_CART',
	SWITCH_STOREFRONT: 'SWITCH_STOREFRONT'
};

// Cart Reducer
const cartReducer = (state, action) => {
	switch (action.type) {
		// One cart per storefront: switching swaps the lines, it never merges them.
		case CART_ACTIONS.SWITCH_STOREFRONT:
			return action.payload.storefrontId === state.storefrontId
				? state
				: { storefrontId: action.payload.storefrontId, items: action.payload.items };

		case CART_ACTIONS.ADD_ITEM: {
			const { quantity = 1, ...line } = action.payload;
			const existingItem = state.items.find(item => item.productId === line.productId);

			if (existingItem) {
				return {
					...state,
					items: state.items.map(item =>
						item.productId === line.productId
							? { ...item, quantity: Math.min(CART_MAX_QUANTITY, item.quantity + quantity) }
							: item
					)
				};
			}
			return {
				...state,
				items: [...state.items, { ...line, quantity: Math.min(CART_MAX_QUANTITY, quantity) }]
			};
		}

		case CART_ACTIONS.REMOVE_ITEM:
			return {
				...state,
				items: state.items.filter(item => item.productId !== action.payload)
			};

		case CART_ACTIONS.UPDATE_QUANTITY: {
			const { productId, quantity } = action.payload;

			if (quantity <= 0) {
				return {
					...state,
					items: state.items.filter(item => item.productId !== productId)
				};
			}

			return {
				...state,
				items: state.items.map(item =>
					item.productId === productId
						? { ...item, quantity }
						: item
				)
			};
		}

		case CART_ACTIONS.CLEAR_CART:
			return { ...state, items: [] };

		default:
			return state;
	}
};

// The storefront and cart a page load starts from: the one last visited, so a refresh on
// /checkout still has its cart. The one-time migration of the old single cart runs here,
// before anything reads the per-storefront keys.
const bootstrapCart = () => {
	migrateLegacyCart(localStorage);
	const storefront = readActiveStorefront(localStorage) ?? normalizeStorefront({ id: DEFAULT_STOREFRONT_ID });
	return { storefront, cart: { storefrontId: storefront.id, items: loadCart(localStorage, storefront.id) } };
};

// Cart Provider Component
export const CartProvider = ({ children }) => {
	const [initial] = useState(bootstrapCart);
	const [cart, dispatch] = useReducer(cartReducer, initial.cart);
	const [activeStorefront, setActiveStorefrontState] = useState(initial.storefront);
	const [comboDetection, setComboDetection] = useState({
		hasCombo: false,
		combo: null,
		savings: 0,
		message: null,
		isChecking: false,
		combos: [],
		optimalPricing: null
	});

	// Only the newest preview request may update state: an older response that
	// lands late would show a total the server no longer computes.
	const pricingRequestId = useRef(0);
	// True while the latest preview failed: the total on screen is then only a
	// retail estimate, so checkout must not offer it as an expectedTotal.
	const [pricingError, setPricingError] = useState(false);

	// Store previous combo state for comparison
	const [previousComboState, setPreviousComboState] = useState({
		hasCombo: false,
		comboIds: [],
		totalSavings: 0
	});

	useEffect(() => {
		writeActiveStorefront(localStorage, activeStorefront);
	}, [activeStorefront]);

	// A page declares which storefront it shows; the cart, the add buttons and checkout
	// follow it. The cart is saved under the id it belongs to, so a switch never writes
	// one storefront's lines into another's key.
	const setActiveStorefront = useCallback((storefront) => {
		if (!storefront?.id) return;
		const next = normalizeStorefront(storefront);
		setActiveStorefrontState((current) => (sameStorefront(current, next) ? current : next));
		dispatch({
			type: CART_ACTIONS.SWITCH_STOREFRONT,
			payload: { storefrontId: next.id, items: loadCart(localStorage, next.id) }
		});
	}, []);

	// No signed-in user (signed out, or a session that expired while the tab was closed) ends
	// the customer's private-storefront carts (shared computers); public carts belong to no
	// account and stay. This also runs on the first resolved lookup, not only on a transition.
	const { data: session, isPending: sessionPending } = useSession();
	const signedInUserId = session?.user?.id ?? null;
	useEffect(() => {
		if (sessionPending || signedInUserId) return;
		clearPrivateCarts(localStorage);
		if (activeStorefront.visibility === 'PRIVATE') dispatch({ type: CART_ACTIONS.CLEAR_CART });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [signedInUserId, sessionPending]);

	// Save cart to localStorage whenever cart changes
	useEffect(() => {
		saveCart(
			localStorage,
			cart.storefrontId,
			cart.items,
			activeStorefront.id === cart.storefrontId ? activeStorefront.visibility : 'PUBLIC'
		);

		// Check for combos when cart changes
		if (cart.items.length > 0) {
			checkForCombos();
		} else {
			pricingRequestId.current++;
			setPricingError(false);
			setComboDetection({
				hasCombo: false,
				combo: null,
				combos: [],
				savings: 0,
				message: null,
				isChecking: false,
				optimalPricing: null
			});

			// Reset previous combo state when cart is empty
			setPreviousComboState({
				hasCombo: false,
				comboIds: [],
				totalSavings: 0
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cart]);

	// Helper function to compare combo states
	const hasComboChanged = (newComboData, previousState) => {
		// If no combo now and no combo before = no change
		if (!newComboData.hasCombo && !previousState.hasCombo) {
			return false;
		}

		// If combo status changed (had combo -> no combo, or no combo -> has combo)
		if (newComboData.hasCombo !== previousState.hasCombo) {
			return true;
		}

		// If both have combos, check if savings amount changed significantly
		if (newComboData.hasCombo && previousState.hasCombo) {
			const savingsDiff = Math.abs(newComboData.savings - previousState.totalSavings);
			// Only consider it changed if savings difference is more than 1000 VND
			return savingsDiff > 1000;
		}

		return false;
	};

	// Check for applicable combos and calculate optimal pricing
	const checkForCombos = useCallback(async () => {
		if (cart.items.length === 0) return;

		const requestId = ++pricingRequestId.current;
		setPricingError(false);
		setComboDetection(prev => ({ ...prev, isChecking: true }));

		try {
			const items = cart.items.map(item => ({
				productId: item.productId,
				quantity: item.quantity
			}));

			const result = await comboService.calculatePricing(items);
			if (requestId !== pricingRequestId.current) return;

			if (!result.success) {
				throw new Error(result.message || 'Failed to calculate pricing');
			}

			// Server shape: { originalTotal, totalAmount, savings, orderItems, comboInfo }.
			// comboInfo.combos lists every combo applied, each with its own savings.
			const combos = result.data.comboInfo ? result.data.comboInfo.combos : [];
			const newComboData = {
				hasCombo: result.data.savings > 0,
				savings: result.data.savings
			};

			// Check if combo state has actually changed
			const comboHasChanged = hasComboChanged(newComboData, previousComboState);

			if (newComboData.hasCombo) {
				setComboDetection({
					hasCombo: true,
					combo: combos.length > 0 ? combos[0] : null,
					combos,
					savings: newComboData.savings,
					message: `Tiết kiệm ${formatCurrency(newComboData.savings)} với combo tối ưu`,
					isChecking: false,
					optimalPricing: result.data
				});

				// Only show toast notification if combo state has changed
				if (comboHasChanged) {
					toast.info(
						`Đã tối ưu giá với combo! Tiết kiệm ${formatCurrency(newComboData.savings)}`,
						{
							position: "bottom-right",
							autoClose: 5000,
							hideProgressBar: false,
							closeOnClick: true,
							pauseOnHover: true,
						}
					);
				}

				// Update previous combo state
				setPreviousComboState({
					hasCombo: true,
					comboIds: combos.map(combo => combo.comboId),
					totalSavings: newComboData.savings
				});
			} else {
				setComboDetection({
					hasCombo: false,
					combo: null,
					combos: [],
					savings: 0,
					message: null,
					isChecking: false,
					optimalPricing: result.data
				});

				// Update previous combo state
				setPreviousComboState({
					hasCombo: false,
					comboIds: [],
					totalSavings: 0
				});
			}
		} catch (error) {
			if (requestId !== pricingRequestId.current) return;
			// A cart kept in localStorage outlives the catalog: a product switched off
			// (or moved to the counter only) would otherwise block checkout forever.
			// Drop exactly the lines the server named; the cart change re-runs pricing.
			const goneIds = error.details?.missingIds || [];
			const gone = cart.items.filter(item => goneIds.includes(item.productId));
			if (gone.length > 0) {
				gone.forEach(item => dispatch({ type: CART_ACTIONS.REMOVE_ITEM, payload: item.productId }));
				toast.warning(
					`Đã bỏ khỏi giỏ vì không còn bán: ${gone.map(item => item.productName).join(', ')}`,
					{ position: "bottom-right", autoClose: 5000 }
				);
				return;
			}
			console.error('Combo detection error:', error.message || error);
			setPricingError(true);
			setComboDetection({
				hasCombo: false,
				combo: null,
				combos: [],
				savings: 0,
				message: null,
				isChecking: false,
				optimalPricing: null
			});

			// Reset previous combo state on error
			setPreviousComboState({
				hasCombo: false,
				comboIds: [],
				totalSavings: 0
			});
		}
	}, [cart, previousComboState]);

	// Cart Actions
	const addToCart = (product, quantity = 1) => {
		// A staff preview of a private storefront may look, not order; the server refuses the order too.
		if (!activeStorefront.canOrder) {
			toast.warning('Tài khoản này không nằm trong danh sách được đặt hàng của gian hàng');
			return;
		}
		dispatch({
			type: CART_ACTIONS.ADD_ITEM,
			payload: {
				storefrontId: cart.storefrontId,
				productId: product._id,
				productName: product.name,
				price: product.price,
				image: product.imageUrl,
				quantity
			}
		});
		toast.success(`Đã thêm ${quantity > 1 ? `${quantity} × ` : ''}"${product.name}" vào giỏ hàng`, {
			position: "bottom-right",
			autoClose: 2000
		});
	};

	const removeFromCart = (productId) => {
		const item = cart.items.find(item => item.productId === productId);
		if (item) {
			dispatch({
				type: CART_ACTIONS.REMOVE_ITEM,
				payload: productId
			});
			toast.info(`Đã xóa "${item.productName}" khỏi giỏ hàng`, {
				position: "bottom-right",
				autoClose: 2000
			});
		}
	};

	const updateQuantity = (productId, quantity) => {
		const item = cart.items.find(item => item.productId === productId);

		if (quantity <= 0) {
			if (item) {
				removeFromCart(productId);
			}
			return;
		}

		dispatch({
			type: CART_ACTIONS.UPDATE_QUANTITY,
			payload: { productId, quantity }
		});
	};

	const increaseQuantity = (productId) => {
		const item = cart.items.find(item => item.productId === productId);
		if (item && item.quantity < CART_MAX_QUANTITY) {
			updateQuantity(productId, item.quantity + 1);
		}
	};

	const decreaseQuantity = (productId) => {
		const item = cart.items.find(item => item.productId === productId);
		if (item) {
			updateQuantity(productId, item.quantity - 1);
		}
	};

	const clearCart = () => {
		dispatch({ type: CART_ACTIONS.CLEAR_CART });
	};

	// Cart Calculations
	const getCartTotal = () => {
		// Use optimal pricing if available
		if (comboDetection.optimalPricing) {
			return comboDetection.optimalPricing.totalAmount;
		}

		// Fallback to base total from individual items
		return cart.items.reduce((total, item) => total + (item.price * item.quantity), 0);
	};

	const getCartItemCount = () => {
		return cart.items.reduce((count, item) => count + item.quantity, 0);
	};

	const getItemQuantity = (productId) => {
		const item = cart.items.find(item => item.productId === productId);
		return item ? item.quantity : 0;
	};

	const isInCart = (productId) => {
		return cart.items.some(item => item.productId === productId);
	};

	// Format currency
	const formatCurrency = (amount) => {
		return new Intl.NumberFormat('vi-VN', {
			style: 'currency',
			currency: 'VND'
		}).format(amount);
	};

	// Pricing figures for display. Without a server preview (still loading, or it
	// failed) they fall back to the plain sum; the checkout waits for the preview
	// before it lets an order be submitted.
	const getPricingBreakdown = () => {
		if (comboDetection.optimalPricing) {
			const { originalTotal, totalAmount, savings } = comboDetection.optimalPricing;
			return { originalTotal, totalAmount, savings, combos: comboDetection.combos };
		}

		const total = cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
		return { originalTotal: total, totalAmount: total, savings: 0, combos: [] };
	};

	const value = {
		cart,
		activeStorefront,
		setActiveStorefront,
		canOrder: activeStorefront.canOrder,
		addToCart,
		removeFromCart,
		updateQuantity,
		increaseQuantity,
		decreaseQuantity,
		clearCart,
		getCartTotal,
		getCartItemCount,
		getItemQuantity,
		isInCart,
		formatCurrency,
		comboDetection,
		pricingError,
		checkForCombos,
		getPricingBreakdown
	};

	return (
		<CartContext.Provider value={value}>
			{children}
		</CartContext.Provider>
	);
};

// Custom Hook to use Cart Context
export const useCart = () => {
	const context = useContext(CartContext);
	if (!context) {
		throw new Error('useCart must be used within a CartProvider');
	}
	return context;
};
