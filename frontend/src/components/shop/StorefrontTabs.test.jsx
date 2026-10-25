import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import StorefrontTabs from './StorefrontTabs';

const render = (props) =>
	renderToStaticMarkup(
		<MemoryRouter>
			<StorefrontTabs {...props} />
		</MemoryRouter>
	);

const PUBLIC = { id: '1', slug: 'public', name: 'Công khai', visibility: 'PUBLIC', locked: false };
const LOCKED = { id: '2', slug: 'club', name: 'CLB', visibility: 'PRIVATE', locked: true };
const OPENED = { id: '3', slug: 'staff', name: 'Nội bộ', visibility: 'PRIVATE', locked: false };

describe('StorefrontTabs', () => {
	it('links each tab to /s/:slug and marks only the active slug', () => {
		const html = render({ storefronts: [PUBLIC, LOCKED], activeSlug: 'club' });

		expect(html).toContain('href="/s/public"');
		expect(html).toContain('href="/s/club"');
		expect(html.match(/aria-current="page"/g)).toHaveLength(1);
		expect(html).toMatch(/aria-current="page"[^>]*>.*CLB/);
	});

	it('shows a closed lock on a locked private tab and an open one once accessible', () => {
		const html = render({ storefronts: [PUBLIC, LOCKED, OPENED], activeSlug: 'public' });

		expect(html.match(/fa-lock(?!-open)/g)).toHaveLength(1);
		expect(html.match(/fa-lock-open/g)).toHaveLength(1);
	});

	it('hides for a single public storefront but not a single private one', () => {
		expect(render({ storefronts: [PUBLIC], activeSlug: 'public' })).toBe('');
		expect(render({ storefronts: [LOCKED], activeSlug: 'club' })).toContain('href="/s/club"');
	});

	it('scrolls sideways instead of wrapping', () => {
		const html = render({ storefronts: [PUBLIC, LOCKED], activeSlug: 'public' });
		expect(html).toContain('flex-nowrap');
		expect(html).toContain('overflow-x-auto');
	});

	it('highlights nothing for a slug missing from the list', () => {
		const html = render({ storefronts: [PUBLIC, LOCKED], activeSlug: 'gone' });
		expect(html).not.toContain('aria-current');
	});

	it('renders nothing without storefronts', () => {
		expect(render({ storefronts: [], activeSlug: 'x' })).toBe('');
	});
});
