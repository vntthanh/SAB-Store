# Sourced as the FIRST line of every hook, before any bash-4 syntax is parsed.
#
# Husky's wrapper (.husky/_/h) runs hooks with `sh -e`, which ignores any
# shebang. On macOS `sh` is bash 3.2 in POSIX mode: `mapfile` does not exist and
# process substitution is disabled, so a hook would die with a syntax error
# before a single check ran. SIP pins /bin/sh to that 3.2, so the interpreter
# has to be swapped from inside the script.
#
# Git Bash on Windows and Linux start these hooks under bash >= 4 already, where
# this file returns immediately and changes nothing.
#
# Deliberately kept POSIX-parseable: bash 3.2 must be able to READ it. Nothing
# below may use array subscripts, `local`, or process substitution.

if [ -n "${BASH_VERSINFO+x}" ] && [ "${BASH_VERSINFO}" -ge 4 ]; then
  return 0
fi

# Homebrew's paths are probed explicitly because a GUI client's login PATH often
# omits them, and the bare `bash` there resolves to the same 3.2 we are escaping.
for _sab_cand in /opt/homebrew/bin/bash /usr/local/bin/bash bash; do
  _sab_bash=$(command -v "$_sab_cand" 2>/dev/null) || continue
  _sab_major=$("$_sab_bash" -c 'echo "${BASH_VERSINFO}"' 2>/dev/null) || continue
  case "$_sab_major" in
    '' | *[!0-9]*) continue ;;
  esac
  if [ "$_sab_major" -ge 4 ]; then
    exec "$_sab_bash" "$0" "$@"
  fi
done

echo "ERROR: git hooks require bash >= 4 (running ${BASH_VERSION:-an unknown shell})." >&2
echo "       macOS ships bash 3.2. Install a modern bash: brew install bash" >&2
exit 1
