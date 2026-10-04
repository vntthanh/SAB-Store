# Sourced by the hooks that run yarn, after hook-env.sh.
#
# hook-env.sh (shared verbatim across repos) gives a GUI git client's bare PATH
# a node and pnpm. This repo uses yarn, whose corepack shim Homebrew does not
# link into its bin dir: it exists only next to the node binary. So when yarn
# is still missing, the directory the resolved node really lives in is added.
# hook-env.sh's keg-only node@<major> probe stays inert here: the root
# package.json pins no `engines.node`, because production builds on node 22
# while the yarn shim on these Macs ships only with the default Homebrew node.
# Where node and yarn already resolve (Git Bash on Windows, nvm/volta shells)
# nothing changes.

if ! command -v yarn >/dev/null 2>&1 && _sab_node=$(command -v node 2>/dev/null); then
  # `cd -P` resolves the Homebrew symlink chain without GNU realpath.
  _sab_dir=$(cd -P "$(dirname "$_sab_node")" && cd -P "$(dirname "$(readlink "$_sab_node" || echo "$_sab_node")")" && pwd)
  PATH="$_sab_dir:$PATH"
  export PATH
  unset _sab_dir
fi
unset _sab_node

# The corepack shim starts with `#!/usr/bin/env node`: check both, so a yarn
# without a node fails here with a clear message instead of a cryptic env error.
if ! command -v node >/dev/null 2>&1 || ! command -v yarn >/dev/null 2>&1; then
  echo "ERROR: git hooks need node and yarn on PATH (searched: $PATH)." >&2
  echo "       Install Node.js (macOS: brew install node) and run 'corepack enable'." >&2
  exit 1
fi
