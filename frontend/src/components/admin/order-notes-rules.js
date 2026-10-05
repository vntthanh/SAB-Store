import { orderNotes } from '@sab/shared';
import { rulesFromSchema } from '../../lib/schema-rules';

// Form values use the payload's key names (`note` is the internal note), so field errors, the
// schema and the server's error list all speak about the same keys. Only what the admin changed
// is sent: an empty internal note or an untouched customer note is left out of the payload.
export const toNotesPayload = ({ additionalNote, savedNote, note }) => {
	const payload = {};
	if (additionalNote !== savedNote) payload.additionalNote = additionalNote.trim();
	if (note.trim()) payload.note = note.trim();
	return payload;
};
export const NOTES_FIELDS = ['additionalNote', 'note'];
export const NOTES_RULES = rulesFromSchema(orderNotes, { fields: NOTES_FIELDS, toPayload: toNotesPayload });
