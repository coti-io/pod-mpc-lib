#!/usr/bin/env bash
# Copy PoD dApp-facing Solidity contracts into coti-contracts at contracts/pod/.
#
# Usage:
#   ./scripts/copy-pod-contracts.sh /path/to/coti-contracts/contracts/pod
#   TARGET=/path/to/coti-contracts/contracts/pod ./scripts/copy-pod-contracts.sh
#
# Optional:
#   POD_MPC_LIB=/path/to/pod-mpc-lib/contracts  (default: <repo>/contracts)
#
# External deps (not copied; imports remapped to target paths):
#   - contracts/utils/mpc/MpcCore.sol
#   - contracts/utils/mpc/MpcInterface.sol
#
# npm deps (unchanged imports):
#   - @openzeppelin/contracts
#
# Requires: bash 3.2+, mkdir, cp, sed, grep, python3 (path normalize + manifest.json)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_ROOT="$(cd "${POD_MPC_LIB:-${REPO_ROOT}/contracts}" && pwd)"
TARGET_ROOT="${1:-${TARGET:-}}"

if [[ -z "$TARGET_ROOT" ]]; then
  echo "Usage: $0 <target/contracts/pod>" >&2
  echo "   or: TARGET=/path/to/coti-contracts/contracts/pod $0" >&2
  exit 1
fi

mkdir -p "$TARGET_ROOT"
TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd)"

if [[ ! -d "$SOURCE_ROOT" ]]; then
  echo "error: source contracts dir not found: $SOURCE_ROOT" >&2
  exit 1
fi

# Explicit roots; transitive local imports are pulled in automatically.
SEED_FILES=(
  PodNetworkConstants.sol
  IInbox.sol
  IInboxMiner.sol
  InboxUser.sol
  InboxUserCotiTestnet.sol
  fee/IInboxFeeManager.sol
  mpc/PodLib.sol
  mpc/PodLib64.sol
  mpc/PodLib128.sol
  mpc/PodLib256.sol
  mpc/PodLibBase.sol
  mpc/PodUser.sol
  mpc/PodUserSepolia.sol
  mpc/PodUserFuji.sol
  mpc/coti-side/IPodExecutorOps.sol
  examples/MpcAdder.sol
  examples/MpcAdderPausable.sol
  examples/it128/PodAdder128.sol
  examples/it256/PodAdder256.sol
  privacy/IPrivacyPortal.sol
  privacy/PrivacyPortal.sol
  privacy/PrivacyPortalFactory.sol
  token/perc20/IPodERC20.sol
  token/perc20/PodERC20.sol
  token/perc20/PodErc20Mintable.sol
  token/perc20/PodErc20MintableInitializable.sol
  token/perc20/cotiside/IPodErc20CotiSide.sol
  token/perc20/cotiside/PodErc20CotiMother.sol
  token/erc7984/IERC7984.sol
  token/erc7984/IERC7984PortalWrapper.sol
  token/erc7984/PodErc7984Mixin.sol
  token/erc7984/Erc7984Pointers.sol
  token/erc7984/Erc7984Constants.sol
  token/erc7984/README.md
)

is_external_mpc() {
  case "$1" in
    utils/mpc/MpcCore.sol | utils/mpc/MpcInterface.sol) return 0 ;;
    *) return 1 ;;
  esac
}

is_solidity() {
  [[ "$1" == *.sol ]]
}

# Join dir + import and normalize (no .. above source root).
norm_join() {
  local from_dir="$1" import_path="$2"
  python3 - "$from_dir" "$import_path" <<'PY'
import os, sys
from_dir, import_path = sys.argv[1], sys.argv[2]
base = from_dir if from_dir != "." else ""
resolved = os.path.normpath(os.path.join(base, import_path))
print(resolved.replace("\\", "/"))
PY
}

resolve_import() {
  local from_file="$1" import_path="$2"
  if [[ "$import_path" == @* ]]; then
    return 1
  fi
  local from_dir="${from_file%/*}"
  [[ "$from_dir" == "$from_file" ]] && from_dir="."
  local resolved
  resolved="$(norm_join "$from_dir" "$import_path")"
  if [[ "$resolved" == ..* ]]; then
    return 1
  fi
  if is_external_mpc "$resolved"; then
    return 1
  fi
  printf '%s' "$resolved"
}

mpc_import_target() {
  local dest_rel="$1" mpc_file="$2"
  local dest_dir="${dest_rel%/*}"
  local depth=0
  if [[ "$dest_dir" != "$dest_rel" ]]; then
    depth="$(echo "$dest_dir" | awk -F/ '{print NF}')"
  fi
  local ups=$((depth + 1))
  local prefix=""
  local i
  for ((i = 0; i < ups; i++)); do
    prefix="../${prefix}"
  done
  printf '%sutils/mpc/%s' "$prefix" "$mpc_file"
}

rewrite_mpc_imports() {
  local dest_rel="$1" src_file="$2" dest_file="$3"
  local core_target iface_target
  core_target="$(mpc_import_target "$dest_rel" MpcCore.sol)"
  iface_target="$(mpc_import_target "$dest_rel" MpcInterface.sol)"
  sed -E \
    -e "s#(\"|')([^\"']*/)?utils/mpc/MpcCore\\.sol(\"|')#\\1${core_target}\\3#g" \
    -e "s#(\"|')([^\"']*/)?utils/mpc/MpcInterface\\.sol(\"|')#\\1${iface_target}\\3#g" \
    "$src_file" >"$dest_file"
}

SEEN_FILE="$(mktemp "${TMPDIR:-/tmp}/copy-pod-seen.XXXXXX")"
trap 'rm -f "$SEEN_FILE"' EXIT

PENDING=()
FILES=()

is_seen() {
  grep -Fxq "$1" "$SEEN_FILE" 2>/dev/null
}

mark_seen() {
  printf '%s\n' "$1" >>"$SEEN_FILE"
}

queue_file() {
  local rel="$1"
  is_seen "$rel" && return 0
  PENDING+=("$rel")
}

for seed in "${SEED_FILES[@]}"; do
  queue_file "$seed"
done

while ((${#PENDING[@]} > 0)); do
  rel="${PENDING[0]}"
  PENDING=("${PENDING[@]:1}")
  is_seen "$rel" && continue

  src="${SOURCE_ROOT}/${rel}"
  if [[ ! -f "$src" ]]; then
    echo "error: missing source file: $rel" >&2
    exit 1
  fi

  mark_seen "$rel"
  FILES+=("$rel")

  if ! is_solidity "$rel"; then
    continue
  fi

  while IFS= read -r import_path; do
    [[ -z "$import_path" ]] && continue
    resolved="$(resolve_import "$rel" "$import_path" || true)"
    [[ -z "$resolved" ]] && continue
    queue_file "$resolved"
  done < <(grep -Eo 'import[[:space:]]+(\{[^}]+\}[[:space:]]+from[[:space:]]+)?["'"'"'][^"'"'"']+["'"'"'][[:space:]]*;' "$src" \
    | sed -E 's/^import[[:space:]]+(\{[^}]+\}[[:space:]]+from[[:space:]]+)?["'"'"']([^"'"'"']+)["'"'"'][[:space:]]*;$/\2/')
done

IFS=$'\n' FILES_SORTED=($(printf '%s\n' "${FILES[@]}" | sort))
unset IFS

echo "Source: $SOURCE_ROOT"
echo "Target: $TARGET_ROOT"
echo "Files:  ${#FILES_SORTED[@]}"
echo

for rel in "${FILES_SORTED[@]}"; do
  src="${SOURCE_ROOT}/${rel}"
  dest="${TARGET_ROOT}/${rel}"
  mkdir -p "$(dirname "$dest")"
  if is_solidity "$rel"; then
    rewrite_mpc_imports "$rel" "$src" "$dest"
  else
    cp "$src" "$dest"
  fi
  echo "  $rel"
done

MANIFEST="${TARGET_ROOT}/manifest.json"
python3 - "$MANIFEST" "$SOURCE_ROOT" "$TARGET_ROOT" "${FILES_SORTED[@]}" <<'PY'
import json, sys
from datetime import datetime, timezone

path, source, target, *files = sys.argv[1:]
payload = {
    "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "source": source,
    "target": target,
    "files": files,
    "externalImports": [
        "utils/mpc/MpcCore.sol",
        "utils/mpc/MpcInterface.sol",
    ],
    "notes": [
        "MpcCore.sol and MpcInterface.sol live at contracts/utils/mpc/ in coti-contracts.",
        "OpenZeppelin imports are unchanged (@openzeppelin/contracts).",
        "Indexers/relayers: use getRequest(requestId) for full inbox payloads (compact MessageSent logs).",
    ],
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
PY

echo
echo "Wrote $MANIFEST"
echo
echo "Suggested remapping (foundry/hardhat):"
echo "  pod/=${TARGET_ROOT}/"
echo "  @openzeppelin/=node_modules/@openzeppelin/"
