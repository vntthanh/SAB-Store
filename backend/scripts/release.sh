#!/bin/sh
# One-shot release step, run before the backend starts (the `release` image
# target): back the database up, then apply pending migrations.
#
# Fails closed. Any failure exits non-zero, and a failed or empty backup means
# no migration runs: a migration must never touch data that has no restore point.
#
# Plain sh on purpose: the image is Alpine (busybox), which ships no bash.
#
# Env:
#   DATABASE_URL  required, postgresql:// URL of the target database
#   BACKUP_DIR    where dumps go (default /backups; a host bind mount in compose)
#   BACKUP_KEEP   newest dumps to keep (default 14)
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"

if [ -z "${DATABASE_URL:-}" ]; then
	echo "release: DATABASE_URL is required" >&2
	exit 1
fi
case "$BACKUP_KEEP" in
'' | *[!0-9]* | 0*)
	# A leading zero would be read as octal by the shell arithmetic below.
	echo "release: BACKUP_KEEP must be a positive integer without leading zeros" >&2
	exit 1
	;;
esac

# Password part of the URL (postgresql://user:password@host/db), so it can be
# scrubbed from tool output next to the whole URL.
db_password=""
case "$DATABASE_URL" in
*://*:*@*)
	userinfo="${DATABASE_URL#*://}"
	userinfo="${userinfo%@*}"
	db_password="${userinfo#*:}"
	;;
esac
export DATABASE_URL db_password

# Runs a command with stdout and stderr scrubbed of the URL and password; the
# exit status is the command's own. Tools like pg_dump and prisma echo
# connection details in their errors, and this output ends up in deploy logs.
run_redacted() {
	log="$(mktemp)"
	status=0
	"$@" >"$log" 2>&1 || status=$?
	awk '
		function scrub(line, secret,    out, i) {
			if (secret == "") return line
			out = ""
			while ((i = index(line, secret)) > 0) {
				out = out substr(line, 1, i - 1) "[redacted]"
				line = substr(line, i + length(secret))
			}
			return out line
		}
		{ print scrub(scrub($0, ENVIRON["DATABASE_URL"]), ENVIRON["db_password"]) }
	' "$log"
	rm -f "$log"
	return "$status"
}

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$BACKUP_DIR/pre-migrate-$stamp.dump"
if [ -e "$dump" ]; then
	echo "release: $dump already exists; refusing to overwrite a backup" >&2
	exit 1
fi

# A dump is written under a unique temporary name and published only after it
# is verified, so a killed or failed run never leaves a truncated file that a
# later restore could mistake for a complete backup, and two runs started in
# the same second never write into one file.
partial="$(mktemp "$BACKUP_DIR/.pre-migrate-$stamp.XXXXXX")"
trap 'rm -f "$partial"' EXIT INT TERM
echo "release: backing up to $dump"
# pg_dump only reads a connection URI from --dbname (PGDATABASE is taken as a
# plain database name). The password is therefore visible in this container's
# process list, which holds nothing but this script; its output is scrubbed.
if ! run_redacted pg_dump --dbname="$DATABASE_URL" --format=custom --file="$partial"; then
	rm -f "$partial"
	echo "release: pg_dump failed; not migrating" >&2
	exit 1
fi
# pg_dump can exit 0 on a truncated write; reading the archive's table of
# contents proves it is a complete custom-format dump.
if [ ! -s "$partial" ] || ! pg_restore --list "$partial" >/dev/null 2>&1; then
	echo "release: the backup is empty or unreadable; not migrating" >&2
	exit 1
fi
# ln fails when the name exists, so a concurrent run can never overwrite a
# published backup (mv would replace it silently).
if ! ln "$partial" "$dump"; then
	echo "release: could not publish $dump; not migrating" >&2
	exit 1
fi
rm -f "$partial"

echo "release: applying migrations"
if ! run_redacted ./node_modules/.bin/prisma migrate deploy; then
	echo "release: prisma migrate deploy failed; the backup is $dump" >&2
	exit 1
fi

# Retention runs last, so a failed release never deletes old restore points.
# Names sort chronologically (UTC stamp); mtime is not trusted, since a copied
# or restored file can carry any. A pruning failure is reported but does not
# fail the release: the migrations are already applied.
# shellcheck disable=SC2012
ls -1 "$BACKUP_DIR"/pre-migrate-*.dump 2>/dev/null |
	sort -r |
	tail -n "+$((BACKUP_KEEP + 1))" |
	while IFS= read -r old; do
		[ "$old" = "$dump" ] && continue
		echo "release: pruning old backup $old"
		rm -f "$old" || echo "release: could not prune $old (ignored)" >&2
	done || echo "release: pruning failed (ignored)" >&2

echo "release: done"
