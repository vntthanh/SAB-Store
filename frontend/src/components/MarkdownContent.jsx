import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Tailwind's preflight strips list bullets and heading sizes, so the elements an
// admin can author get their styling back here. Colour is inherited from the
// surrounding box. Raw HTML in the source is escaped (no rehype-raw) and
// react-markdown's default urlTransform drops javascript: links: the text comes
// from an admin, but it is rendered on every customer's checkout page.
const components = {
	p: ({ node, ...props }) => <p className="mb-2 last:mb-0" {...props} />,
	ul: ({ node, ...props }) => <ul className="list-disc ml-4 space-y-1 mb-2 last:mb-0" {...props} />,
	ol: ({ node, ...props }) => <ol className="list-decimal ml-4 space-y-1 mb-2 last:mb-0" {...props} />,
	a: ({ node, ...props }) => <a className="underline" target="_blank" rel="noopener noreferrer" {...props} />,
	h1: ({ node, ...props }) => <h3 className="font-semibold text-base mb-1" {...props} />,
	h2: ({ node, ...props }) => <h4 className="font-semibold mb-1" {...props} />,
	h3: ({ node, ...props }) => <h5 className="font-semibold mb-1" {...props} />,
	code: ({ node, ...props }) => <code className="px-1 rounded bg-black/5" {...props} />,
	table: ({ node, ...props }) => <table className="border-collapse my-2" {...props} />,
	th: ({ node, ...props }) => <th className="border px-2 py-1 text-left" {...props} />,
	td: ({ node, ...props }) => <td className="border px-2 py-1" {...props} />
};

const MarkdownContent = ({ children, className = '' }) => (
	<div className={className}>
		<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
			{children}
		</ReactMarkdown>
	</div>
);

export default MarkdownContent;
