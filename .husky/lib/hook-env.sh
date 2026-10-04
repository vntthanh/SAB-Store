# Sourced by every hook right after require-bash.sh (bash >= 4 by then).
# Shared verbatim with heavy-lock.sh across the repos on these machines.
#
# A GUI git client (GitHub Desktop, an IDE) runs hooks with a bare PATH that
# lacks Homebrew's keg-only node@<major> and pnpm. Only what is missing is
# added: node@<major> goes first, and only when no node is found at all; the
# other directories are appended, so a node the user picked (nvm, volta) keeps
# winning. The major comes from package.json `engines.node`, its single owner.
# require-bash.sh probes Homebrew's bash for the same GUI reason, before this.
_hk_add_path() {
  case ":$PATH:" in
    *":$1:"*) ;;
    *) if [ -d "$1" ]; then PATH="$PATH:$1"; fi ;;
  esac
}
if ! command -v node >/dev/null 2>&1; then
  _hk_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
  _hk_major=$(sed -n 's/.*"node": *"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$_hk_root/package.json" 2>/dev/null | head -n 1)
  if [ -n "$_hk_major" ] && [ -d "/opt/homebrew/opt/node@$_hk_major/bin" ]; then
    PATH="/opt/homebrew/opt/node@$_hk_major/bin:$PATH"
  fi
  unset _hk_root _hk_major
fi
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  # Windows entries use Git Bash's /c/... form via $HOME: GitHub Desktop's git
  # ships no cygpath to convert %LOCALAPPDATA%.
  for _hk_dir in /opt/homebrew/bin /usr/local/bin "$HOME/Library/pnpm/bin" "${PNPM_HOME:-}" \
    "/c/Program Files/nodejs" "$HOME/AppData/Local/pnpm" "$HOME/AppData/Roaming/npm"; do
    if [ -n "$_hk_dir" ]; then _hk_add_path "$_hk_dir"; fi
  done
  unset _hk_dir
fi
unset -f _hk_add_path
