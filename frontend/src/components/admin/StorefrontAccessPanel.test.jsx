import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../services/api', () => ({
	storefrontAdminService: {},
	emailListService: {}
}));

import { buildRuleRequest, RuleSummary } from './StorefrontAccessPanel';
import { ImportPreview } from './EmailImportDialog';

const LIST_ID = '01a173f3-7280-71fd-b24f-118da6196e35';

describe('buildRuleRequest', () => {
	it('builds an EMAIL, DOMAIN and LIST request', () => {
		expect(buildRuleRequest('EMAIL', 'a@x.com', '').payload).toEqual({ type: 'EMAIL', value: 'a@x.com' });
		expect(buildRuleRequest('DOMAIN', 'school.edu.vn', '').payload).toEqual({ type: 'DOMAIN', value: 'school.edu.vn' });
		expect(buildRuleRequest('LIST', '', LIST_ID).payload).toEqual({ type: 'LIST', emailListId: LIST_ID });
	});

	it('returns the schema message for a bad email or domain', () => {
		expect(buildRuleRequest('EMAIL', 'nope', '').error).toBe('Email không hợp lệ');
		expect(buildRuleRequest('DOMAIN', 'edu', '').error).toMatch(/^Tên miền không hợp lệ/);
	});

	it('asks to pick a list when none is chosen', () => {
		expect(buildRuleRequest('LIST', '', '').error).toBe('Hãy chọn một danh sách email');
	});
});

describe('RuleSummary', () => {
	it('shows a domain with @ and a list with its name and size', () => {
		expect(renderToStaticMarkup(<RuleSummary rule={{ type: 'DOMAIN', value: 'school.edu.vn' }} />)).toContain('@school.edu.vn');
		const list = renderToStaticMarkup(<RuleSummary rule={{ type: 'LIST', emailListName: 'K65', entryCount: 120 }} />);
		expect(list).toContain('K65');
		expect(list).toContain('120 email');
	});
});

describe('ImportPreview', () => {
	it('renders the 3 / 1 / 1 counts and the invalid token', () => {
		const html = renderToStaticMarkup(
			<ImportPreview preview={{ validCount: 3, duplicateCount: 1, invalidCount: 1, invalidSample: ['bad'], tooMany: false }} />
		);
		expect(html).toContain('<strong>3</strong> email hợp lệ');
		expect(html).toContain('<strong>1</strong> trùng đã loại');
		expect(html).toContain('<strong>1</strong> không hợp lệ');
		expect(html).toContain('bad');
	});
});
