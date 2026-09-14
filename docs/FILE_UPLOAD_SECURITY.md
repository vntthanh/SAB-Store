# File Upload Security Validation

## Overview
This document describes the comprehensive security validation system implemented for file uploads to prevent malicious code injection and attacks.

## Security Features

### 1. File Signature Validation (Magic Number Check)
- Validates actual file content by checking magic numbers (file signatures)
- Prevents attackers from uploading malicious files with fake extensions
- Supported formats with their signatures:
  - **JPEG**: `FF D8 FF DB/E0/E1/EE`
  - **PNG**: `89 50 4E 47 0D 0A 1A 0A`
  - **GIF**: `47 49 46 38 37/39 61`
  - **WebP**: `52 49 46 46`

### 2. MIME Type Validation
- Strict whitelist of allowed MIME types
- Rejects any file not matching: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- Prevents executable files and scripts from being uploaded

### 3. File Extension Validation
- Cross-validates extension against declared MIME type
- Blocks mismatched extensions (e.g., PNG content with .jpg extension)

### 4. File Size Limits
- Maximum file size: **10MB** — `backend/utils/fileValidator.js:37`
- Prevents Denial of Service (DoS) attacks via large file uploads
- Configurable via `MAX_FILE_SIZE` constant

### 5. Filename Sanitization
Protects against multiple attack vectors:

#### Path Traversal Prevention
- Blocks `../` sequences
- Blocks forward slashes `/` and backslashes `\`
- Prevents access to parent directories

#### Dangerous Extension Blocking
- Blocks executable files: `.exe`, `.bat`, `.cmd`, `.sh`
- Blocks scripts: `.js`, `.php`, `.asp`, `.jsp`
- Blocks HTML/SVG: `.html`, `.htm`, `.svg`

#### Special Character Removal
- Removes: `<`, `>`, `:`, `"`, `|`, `?`, `*`
- Prevents XSS and command injection
- Normalizes Unicode characters

#### Reserved Filename Protection
- Blocks Windows reserved names: `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`

### 6. Secure Filename Generation
- Generates unique, unpredictable filenames using `crypto.randomBytes(12)` (not `Math.random`,
  which is not cryptographically secure and is predictable enough to guess) —
  `backend/utils/fileValidator.js:generateSecureFilename`
- Format: `image-{timestamp}-{randomHex}.{ext}`
- Prevents filename conflicts and enumeration attacks

## Implementation Files

### `backend/utils/fileValidator.js`
Core validation module containing:
- `validateImageFile(file)` - Main validation function
- `sanitizeFilename(filename)` - Filename sanitization
- `generateSecureFilename(originalFilename)` - Secure name generation
- `checkFileSignature(buffer, mimetype)` - Magic number validation

### `backend/routes/upload.js`
Updated upload routes with security integration:
- Single file upload: `POST /product-image`
- Multiple file upload: `POST /product-images`
- File deletion: `DELETE /product-image/:filename`

### `backend/tests/validation/upload-file-guards.test.js`
Jest suite covering the upload path end to end: `MAX_FILE_SIZE` value, oversized-file
rejection, RIFF-without-WEBP signature rejection, genuine WebP signature acceptance, and that
500 responses carry a `correlationId` with no raw error leaked.

## Test Results

Run via the backend's own suite (`cd backend && npx jest`), not a standalone script — see
that command's output for current pass/fail status. There is no
`backend/test/test_file_validation.js`; if a doc or script elsewhere references that path, it
does not exist in this repo.

## Usage Example

```javascript
const { validateImageFile, generateSecureFilename } = require('../utils/fileValidator');

router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    // Validate file security
    await validateImageFile(req.file);
    
    // Generate secure filename
    const filename = generateSecureFilename(req.file.originalname);
    
    // Process upload
    await uploadFile(filename, req.file.buffer, req.file.mimetype);
    
    res.json({ success: true, filename });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});
```

## Error Messages

The system provides clear, specific error messages:

- `"File signature does not match declared type. Possible malicious file."`
- `"Invalid MIME type: {type}. Allowed types: {list}"`
- `"File extension does not match MIME type {type}"`
- `"File size exceeds maximum allowed size of 10MB"`
- `"Invalid filename: contains dangerous characters or patterns"`

## Security Best Practices

1. **Never trust client-provided data** - Always validate on server
2. **Check file content, not just extension** - Use magic numbers
3. **Sanitize all user input** - Including filenames
4. **Use strict whitelists** - Don't rely on blacklists
5. **Generate unique filenames** - Prevent overwriting and enumeration
6. **Limit file sizes** - Prevent resource exhaustion
7. **Store files outside web root** - Use object storage (MinIO)

## Testing

Run the test suite:

```bash
cd backend && npx jest tests/validation/upload-file-guards.test.js
```

## Configuration

Adjust limits in `backend/utils/fileValidator.js`:

```javascript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // Modify as needed

const ALLOWED_IMAGE_TYPES = {
  // Add or remove supported types
};
```

## Attack Vectors Mitigated

- [OK] Malicious file upload (executable disguised as image)
- [OK] Path traversal attacks (`../../../etc/passwd`)
- [OK] File extension spoofing (fake MIME types)
- [OK] XSS via filenames (`<script>alert(1)</script>.jpg`)
- [OK] Command injection via filenames
- [OK] DoS via large file uploads
- [OK] File enumeration attacks
- [OK] Reserved filename exploitation

## Compliance

This implementation follows security standards from:
- OWASP File Upload Security Guidelines
- CWE-434: Unrestricted Upload of File with Dangerous Type
- CWE-22: Improper Limitation of a Pathname to a Restricted Directory
