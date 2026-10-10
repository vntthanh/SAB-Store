import React, { Suspense, lazy } from 'react';
import { MONACO_VS_PATH } from '../../lib/monaco-assets';
import MarkdownContent from '../MarkdownContent';

// Configured inside the lazy factory: a module-level `loader.config` would need a
// top-level import of @monaco-editor/react and pull it into the main bundle, and
// the config must land before the first Editor mounts and calls loader.init().
// Every editor goes through this module, so nothing else can reach the CDN default.
const Editor = lazy(async () => {
	const mod = await import('@monaco-editor/react');
	mod.loader.config({ paths: { vs: MONACO_VS_PATH } });
	return { default: mod.default };
});

const EDITOR_OPTIONS = {
	lineNumbers: 'on',
	wordWrap: 'on',
	minimap: { enabled: false },
	scrollBeyondLastLine: false,
	automaticLayout: true,
	fontSize: 14,
	tabSize: 2,
	quickSuggestions: false
};

const EditorFallback = () => (
	<div className="h-full flex items-center justify-center text-sm text-gray-500">
		Đang tải trình soạn thảo...
	</div>
);

/**
 * Markdown source in Monaco (line numbers, syntax highlighting) beside a live
 * preview rendered by the same MarkdownContent the customer pages use, so what
 * the admin sees is what customers get.
 */
const MarkdownEditor = ({ ariaLabel, value, onChange, maxLength, height = 220, previewClassName = '' }) => (
	<div>
		<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
			<div className="border border-gray-300 rounded-md overflow-hidden" style={{ height }}>
				<Suspense fallback={<EditorFallback />}>
					<Editor
						language="markdown"
						value={value}
						onChange={(next) => onChange(next ?? '')}
						options={{ ...EDITOR_OPTIONS, ariaLabel }}
					/>
				</Suspense>
			</div>
			<div className="border border-dashed border-gray-300 rounded-md p-3 overflow-auto" style={{ height }}>
				{value.trim() ? (
					<MarkdownContent className={`text-sm ${previewClassName}`}>{value}</MarkdownContent>
				) : (
					<p className="text-sm text-gray-400 italic">Để trống: lời nhắc này sẽ bị ẩn</p>
				)}
			</div>
		</div>
		{maxLength && (
			<p className={`mt-1 text-xs ${value.length > maxLength ? 'text-red-600' : 'text-gray-500'}`}>
				{value.length}/{maxLength} ký tự
			</p>
		)}
	</div>
);

export default MarkdownEditor;
