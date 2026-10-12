// The phrase an admin types before a restore replaces the store's business data.
// The backend refuses a restore request that does not carry it, and the admin
// page keeps its button disabled until the input matches, so both sides read it
// from here.
export const RESTORE_CONFIRMATION = 'KHOI PHUC';
