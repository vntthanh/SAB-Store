import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart } from '../context/CartContext';
import { settingsService, DEFAULT_STORE_TITLE } from '../services/api';
import Logo from './Logo';

const STORE_TITLE_CACHE_KEY = 'storeTitle';

// Storage can throw (private mode, blocked site data); the title is cosmetic,
// so a failure just means no cached value.
const readCachedTitle = () => {
  try {
    return localStorage.getItem(STORE_TITLE_CACHE_KEY) || '';
  } catch {
    return '';
  }
};

const writeCachedTitle = (title) => {
  try {
    localStorage.setItem(STORE_TITLE_CACHE_KEY, title);
  } catch {
    // Not cached; the next load fetches it again.
  }
};

const Header = () => {
  const { getCartItemCount, formatCurrency, getCartTotal } = useCart();
  const itemCount = getCartItemCount();
  const total = getCartTotal();
  // Start from the last title this browser saw, so a renamed store does not
  // flash the default on every page load. Empty until the first fetch settles.
  const [storeTitle, setStoreTitle] = useState(readCachedTitle);

  useEffect(() => {
    let active = true;
    settingsService.getPublicSettings()
      .then((settings) => {
        if (active && settings?.storeTitle) {
          setStoreTitle(settings.storeTitle);
          writeCachedTitle(settings.storeTitle);
        }
      })
      // A missing title is not worth an error toast; fall back quietly.
      .catch(() => {
        if (active) {
          setStoreTitle((current) => current || DEFAULT_STORE_TITLE);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  // Scroll to cart-sidebar when cart summary is clicked
  const handleCartSummaryClick = () => {
    const el = document.getElementById('cart-sidebar');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };
  return (
    <header className="bg-white shadow-md sticky top-0 z-50">
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          {/* Logo */}
          <Link 
            to="/" 
            className="flex items-center space-x-3 text-2xl font-bold text-blue-800 hover:text-blue-900 transition-colors"
          >
            <Logo size="lg" />
            <span className="text-blue-800 hidden sm:inline">
              <span className="text-yellow-500">|</span> {storeTitle}
            </span>
          </Link>

          {/* Navigation */}
          <nav className="hidden md:flex items-center space-x-6">
            <Link 
              to="/" 
              className="text-gray-700 hover:text-blue-700 transition-colors font-medium"
            >
              Trang chủ
            </Link>
            <Link 
              to="/order-tracking" 
              className="text-gray-700 hover:text-blue-700 transition-colors font-medium"
            >
              Tra cứu đơn hàng
            </Link>
          </nav>

          {/* Cart Summary */}
          <div className="flex items-center space-x-4">
            {/* Cart Icon with Count */}
            <div className="relative cursor-pointer" onClick={handleCartSummaryClick}>
              <div className="flex items-center space-x-2 bg-gray-100 px-3 py-2 rounded-lg">
                <i className="fas fa-shopping-bag text-gray-600"></i>
                <div className="text-sm">
                  <div className="font-medium text-gray-900">
                    {itemCount} món
                  </div>
                  <div className="text-gray-600">
                    {formatCurrency(total)}
                  </div>
                </div>
              </div>
              
              {/* Cart Count Badge */}
              {itemCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-danger-500 text-white text-xs rounded-full h-6 w-6 flex items-center justify-center font-bold">
                  {itemCount > 99 ? '99+' : itemCount}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Mobile Navigation */}
        <nav className="md:hidden mt-4 flex items-center justify-center space-x-6 border-t pt-4">
          <Link 
            to="/" 
            className="text-gray-700 hover:text-primary-600 transition-colors font-medium"
          >
            <i className="fas fa-home mr-1"></i>
            Trang chủ
          </Link>
          <Link 
            to="/order-tracking" 
            className="text-gray-700 hover:text-primary-600 transition-colors font-medium"
          >
            <i className="fas fa-search mr-1"></i>
            Tra cứu
          </Link>
        </nav>
      </div>
    </header>
  );
};

export default Header;
