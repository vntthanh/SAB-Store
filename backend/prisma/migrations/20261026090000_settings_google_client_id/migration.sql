-- Google One Tap's client id moves from the environment to an admin setting.
-- NULL = never set, which reads as Google sign-in off.
ALTER TABLE "settings" ADD COLUMN "google_client_id" TEXT;
