# Machine-wide heavy-job lock for git hooks, shared verbatim by every repo on
# these machines (Leaderboard owns the canonical copy; JudgeHub, QR, SAB-Store,
# ComparableTransaction copy it unchanged). A hook's typecheck/lint/test suite
# is heavy; taking the lock inside the hook means no caller, a GUI git client
# included, can run it outside the lock.
#
# Protocol (AGENTS.md §5 "Chi phí chạy test — khoá dùng chung toàn máy"):
# - wait in a wants-flag queue, one flag per process
#   `<root>/cc-heavy.<repo>-<pid>-wants`, oldest epoch first; a live flag
#   (mtime <= 5 min) that is empty or unreadable counts as older than ours;
#   flags older than 5 min are dead and are ignored, never deleted;
# - free memory must be >= 35% (21% on Windows): macOS `memory_pressure -Q`;
#   Windows available bytes (free + standby cache, as Task Manager counts it)
#   through powershell.exe; Linux MemAvailable. Skipped where none can be read.
#   Windows gets the lower floor because WSL's vmmem and memory compression
#   keep a large share reserved on the owner's 48 GB machine: 35% there blocked
#   a hook for ~19 min with 13 GB free (owner decision 2026-10-07);
# - give up after CC_HEAVY_WAIT_MAX seconds (default 30 min) with a failing
#   hook rather than ever running the heavy steps without the lock;
# - acquire with an atomic `mkdir <root>/cc-heavy.lock` and an exact owner line
#   `<Repo> <job>-<pid> <epoch>`;
# - release only when the owner line is still ours (`grep -qxF ... && rm`),
#   never unconditionally; also on INT/TERM/HUP, so a cancelled or timed-out
#   hook does not leave the lock held (a waiter likewise removes only its own
#   wants flag). SIGKILL cannot run a handler: that lock stays until someone
#   checks the owner line and removes it by hand.
#
# A caller that already holds the lock exports CC_HEAVY_OWNER with its exact
# owner line in the same command as `git commit`/`git push`; the hook then runs
# inside that lock and neither waits for nor releases it. Without it the hook
# waits on a lock its own caller holds, forever.
#
# Usage in a hook, after require-bash.sh and `set -Eeuo pipefail`:
#   source .husky/lib/heavy-lock.sh
#   heavy_lock_hook <Repo> <job> "$0" "$@"
# Without a held lock this re-runs the hook under the lock and exits with its
# status; the re-run (and a caller that already holds the lock) returns here.
# The re-run inherits the helper's stdin, so redirect it on the call
# (`heavy_lock_hook ... <<<"$saved"`) when the hook already consumed stdin.
#
# Needs bash (not plain sh). Env overrides:
# - CC_HEAVY_ROOT, or CC_HEAVY_TMP (the name other repos use): the lock
#   directory, for a GUI client whose git resolves /tmp elsewhere (Windows).
# - CC_HEAVY_WAIT_MAX (or CC_HEAVY_WAIT_MAX_SECONDS): seconds to wait before
#   giving up (default 1800).
# - CC_HEAVY_MIN_FREE_PCT: the free-memory floor in percent (default above).
# - Tests only: CC_HEAVY_POLL_SECONDS.

CC_HEAVY_ROOT="${CC_HEAVY_ROOT:-${CC_HEAVY_TMP:-/tmp}}"
CC_HEAVY_LOCK="$CC_HEAVY_ROOT/cc-heavy.lock"
if [ -z "${CC_HEAVY_MIN_FREE_PCT:-}" ]; then
  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*) CC_HEAVY_MIN_FREE_PCT=21 ;;
    *) CC_HEAVY_MIN_FREE_PCT=35 ;;
  esac
fi
CC_HEAVY_POLL_SECONDS="${CC_HEAVY_POLL_SECONDS:-10}"
CC_HEAVY_WAIT_MAX="${CC_HEAVY_WAIT_MAX:-${CC_HEAVY_WAIT_MAX_SECONDS:-1800}}"
# A non-number would make every deadline test false and silently drop the cap.
case "$CC_HEAVY_WAIT_MAX" in
  '' | *[!0-9]*) CC_HEAVY_WAIT_MAX=1800 ;;
esac
CC_HEAVY_FLAG_TTL_SECONDS=300

# File mtime in epoch seconds (GNU stat first, then BSD); 0 = dead flag.
heavy_lock_mtime() {
  local m
  m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || true)
  case "$m" in
    '' | *[!0-9]*) echo 0 ;;
    *) echo "$m" ;;
  esac
}

# Under `set -E` the ERR trap fires inside $(...), so a failing pipeline here
# would abort the caller; `|| true` turns an unparsable reading into 100.
heavy_lock_free_pct() {
  local pct=''
  if command -v memory_pressure >/dev/null 2>&1; then
    pct=$(memory_pressure -Q 2>/dev/null | grep -o '[0-9]*%' | tr -d '%' | tail -1 || true)
  elif command -v powershell.exe >/dev/null 2>&1; then
    pct=$(powershell.exe -NoProfile -NonInteractive -Command \
      '$m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; $o = Get-CimInstance Win32_OperatingSystem; [int]($m.AvailableBytes * 100 / ($o.TotalVisibleMemorySize * 1024))' \
      2>/dev/null | tr -d '\r' || true)
  elif [ -r /proc/meminfo ]; then
    pct=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{if (t && a != "") print int(a*100/t)}' /proc/meminfo || true)
  fi
  case "$pct" in
    '' | *[!0-9]*) pct=100 ;;
  esac
  echo "$pct"
}

# GitHub Desktop's bundled git on Windows ships no `sleep`; without this the
# wait loop would spin, launching powershell.exe for the memory gate every pass.
# heavy_lock_acquire refuses to start when neither exists, rather than spin.
heavy_lock_sleep() {
  if command -v sleep >/dev/null 2>&1; then
    sleep "$1"
  else
    powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds $1" >/dev/null 2>&1 || true
  fi
}

# Who holds the lock, for messages: the owner line, or how long an ownerless
# lock (holder SIGKILLed between mkdir and the owner write) has existed.
heavy_lock_holder() {
  local o age
  o=$(cat "$CC_HEAVY_LOCK/owner" 2>/dev/null || true)
  if [ -n "$o" ]; then
    echo "$o"
  elif [ -d "$CC_HEAVY_LOCK" ]; then
    age=$(($(date +%s) - $(heavy_lock_mtime "$CC_HEAVY_LOCK")))
    echo "no owner line, lock dir ${age}s old; if no hook is running, remove $CC_HEAVY_LOCK by hand"
  else
    echo none
  fi
}

# Is our flag first in the queue? $1 = our flag path, $2 = our epoch.
heavy_lock_my_turn() {
  local mine="$1" epoch="$2" now other_epoch age f
  now=$(date +%s)
  for f in "$CC_HEAVY_ROOT"/cc-heavy.*-wants; do
    [ -e "$f" ] || continue
    [ "$f" = "$mine" ] && continue
    age=$((now - $(heavy_lock_mtime "$f")))
    [ "$age" -gt "$CC_HEAVY_FLAG_TTL_SECONDS" ] && continue
    other_epoch=$(awk '{print $NF}' "$f" 2>/dev/null)
    case "$other_epoch" in
      '' | *[!0-9]*) return 1 ;;
    esac
    if [ "$other_epoch" -lt "$epoch" ]; then return 1; fi
    if [ "$other_epoch" -eq "$epoch" ] && [[ "$f" < "$mine" ]]; then return 1; fi
  done
  return 0
}

# heavy_lock_acquire <repo> <job>: blocks until acquired. Runs in the caller's
# own process (no $(...)) and sets the caller's locals `flag` (our wants flag,
# while waiting) and `owner` (set the moment mkdir succeeds, so the signal
# handler can always see it).
heavy_lock_acquire() {
  local repo="$1" job="$2-$$" epoch free last_msg=0 now line
  if ! command -v sleep >/dev/null 2>&1 && ! command -v powershell.exe >/dev/null 2>&1; then
    echo "heavy-lock: no sleep or powershell.exe on PATH, so it cannot wait for the lock; nothing ran" >&2
    exit 1
  fi
  epoch=$(date +%s)
  line="$repo $job $epoch"
  flag="$CC_HEAVY_ROOT/cc-heavy.$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')-$$-wants"
  while :; do
    # Rewritten (not just touched) so a live flag is never empty.
    printf '%s\n' "$line" >"$flag"
    free=$(heavy_lock_free_pct)
    if heavy_lock_my_turn "$flag" "$epoch" && [ "$free" -ge "$CC_HEAVY_MIN_FREE_PCT" ] &&
      mkdir "$CC_HEAVY_LOCK" 2>/dev/null; then
      # Set immediately after mkdir, never before: the handler's cleanup of an
      # unwritten owner file would otherwise delete another holder's fresh lock.
      owner="$line"
      printf '%s\n' "$owner" >"$CC_HEAVY_LOCK/owner"
      rm -f "$flag"
      flag=''
      return 0
    fi
    now=$(date +%s)
    if [ $((now - epoch)) -ge "$CC_HEAVY_WAIT_MAX" ]; then
      rm -f "$flag"
      flag=''
      echo "heavy-lock: gave up after ${CC_HEAVY_WAIT_MAX}s (holder: $(heavy_lock_holder), free memory ${free}%); nothing ran, retry later" >&2
      exit 1
    fi
    if [ $((now - last_msg)) -ge 60 ]; then
      {
        echo "heavy-lock: waiting (holder: $(heavy_lock_holder), free memory ${free}%)"
        echo "heavy-lock: if your shell already holds this lock, export CC_HEAVY_OWNER='<owner line>' before git commit/push"
      } >&2
      last_msg=$now
    fi
    # Background + wait: a trap runs as soon as `wait` returns, not after the sleep.
    heavy_lock_sleep "$CC_HEAVY_POLL_SECONDS" &
    wait $!
  done
}

# Releases only a lock whose owner line is still exactly ours.
heavy_lock_release() {
  [ -n "$1" ] || return 0
  grep -qxF "$1" "$CC_HEAVY_LOCK/owner" 2>/dev/null && rm -rf "$CC_HEAVY_LOCK"
  return 0
}

# INT/TERM/HUP handler of heavy_lock_hook (reads its locals by dynamic scope):
# drops our wants flag, releases the lock only if still ours.
# `owner` set with an empty or missing owner file means we were signalled
# between mkdir and the owner write: no one else can have written it.
heavy_lock_on_signal() {
  # Take `owner` first: a signal after we released (or a second signal) must not
  # run the cleanup below, whose rmdir could take another holder's fresh lock.
  local mine="$owner"
  owner=''
  if [ -n "$flag" ]; then rm -f "$flag"; fi
  if [ -n "$mine" ] && [ ! -s "$CC_HEAVY_LOCK/owner" ]; then
    rm -f "$CC_HEAVY_LOCK/owner"
    rmdir "$CC_HEAVY_LOCK" 2>/dev/null || true
  fi
  heavy_lock_release "$mine"
  exit "$1"
}

# heavy_lock_hook <Repo> <job> <hook-script> [hook args...]
# Returns 0 when the caller already holds the lock (CC_HEAVY_OWNER matches the
# owner file exactly). Otherwise acquires, re-runs the hook script with
# CC_HEAVY_OWNER exported (stdin passes through), releases, and exits with the
# hook's status. The status is captured with `||` so the caller's `set -e` and
# ERR trap (which would exit before the release) do not fire on a failing hook.
# The hook runs in the foreground, in our process group: Ctrl-C and group kills
# reach its whole tree directly (a background child would start with SIGINT
# ignored, and so would pnpm/vitest under it). Bash runs our trap once it
# exits; a signal sent to this process alone therefore takes effect when the
# hook ends, and the lock stays held meanwhile.
heavy_lock_hook() {
  local repo="$1" job="$2" script="$3" owner='' mine='' flag='' rc=0
  shift 3
  if [ -n "${CC_HEAVY_OWNER:-}" ] && grep -qxF "$CC_HEAVY_OWNER" "$CC_HEAVY_LOCK/owner" 2>/dev/null; then
    return 0
  fi
  trap 'heavy_lock_on_signal 130' INT
  trap 'heavy_lock_on_signal 143' TERM
  trap 'heavy_lock_on_signal 129' HUP
  heavy_lock_acquire "$repo" "$job"
  CC_HEAVY_OWNER="$owner" "$BASH" "$script" "$@" || rc=$?
  # Clear before releasing, so a signal mid-release sees no owner and skips the cleanup.
  mine="$owner"
  owner=''
  heavy_lock_release "$mine"
  trap - INT TERM HUP
  exit "$rc"
}
