#!/usr/bin/env bash
# Copy Solidity sources dApp developers need to build contracts on top of PoD,
# including packaged PoD dApps such as pERC20 and PrivacyPortal. Most paths are
# preserved; `privacy/` sources are copied to `privacyPortal/`.
#
# Usage:
#   ./scripts/copy-pod-dapp-contracts.sh /path/to/your-project/contracts/pod
#   TARGET=/path/to/lib POD_MPC_LIB=/path/to/pod-mpc-lib/contracts ./scripts/copy-pod-dapp-contracts.sh
#
# Requires: bash, mkdir, and cp. No rsync or GNU install needed.
#
# Compile-time deps still come from npm (not copied here):
#   - @openzeppelin/contracts
#
# Vendored MPC core (copied below):
#   - utils/mpc/MpcCore.sol
#   - utils/mpc/MpcInterface.sol

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SOURCE="${POD_MPC_LIB:-${REPO_ROOT}/contracts}"
TARGET="${1:-${TARGET:?Pass target directory as \$1 or set TARGET=}}"

if [[ ! -d "$SOURCE" ]]; then
  echo "error: source contracts dir not found: $SOURCE" >&2
  echo "Set POD_MPC_LIB to your pod-mpc-lib/contracts path." >&2
  exit 1
fi

FILES=(
  # Inbox interface and access helper used by Pod dApps.
  IInbox.sol
  InboxUser.sol
  InboxUserCotiTestnet.sol
  PodNetworkConstants.sol
  fee/IInboxFeeManager.sol

  # Pod application base contracts and MPC call helpers.
  mpc/PodUser.sol
  mpc/PodUserSepolia.sol
  mpc/PodLibBase.sol
  mpc/PodLib64.sol
  mpc/PodLib128.sol
  mpc/PodLib256.sol
  mpc/PodLib.sol
  mpccodec/MpcAbiCodec.sol

  # Vendored COTI MPC core used by Pod contracts and pERC20 COTI side.
  utils/mpc/MpcCore.sol
  utils/mpc/MpcInterface.sol

  # Executor operation interfaces referenced by the Pod libraries.
  mpc/coti-side/IPodExecutorOps.sol

  # pERC20 is a PoD dApp, so copy its full production source + COTI-side stack.
  token/perc20/IPodERC20.sol
  token/perc20/PodERC20.sol
  token/perc20/PodErc20Mintable.sol
  token/perc20/PodErc20MintableInitializable.sol
  token/perc20/cotiside/IPodErc20CotiSide.sol
  token/perc20/cotiside/PodErc20CotiSide.sol
  token/perc20/cotiside/PodErc20CotiSideInitializable.sol

  # PrivacyPortal is a PoD dApp, so copy its full production source + factories.
  privacy/IPrivacyPortal.sol
  privacy/PrivacyPortal.sol
  privacy/PrivacyPortalFactory.sol
  privacy/PodErc20CotiSideFactory.sol
)

echo "Source: $SOURCE"
echo "Target: $TARGET"
echo

for rel in "${FILES[@]}"; do
  src="${SOURCE%/}/${rel}"
  if [[ ! -f "$src" ]]; then
    echo "error: missing file: $src" >&2
    exit 1
  fi
  dest_rel="$rel"
  if [[ "$dest_rel" == privacy/* ]]; then
    dest_rel="privacyPortal/${dest_rel#privacy/}"
  fi
  dest="${TARGET%/}/${dest_rel}"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  if [[ "$dest_rel" == "$rel" ]]; then
    echo "  copied $rel"
  else
    echo "  copied $rel -> $dest_rel"
  fi
done

echo
echo "Done. Wire remappings in your Solidity project so these paths resolve, e.g."
echo "  pod/ = $TARGET/"
echo "then import as: import { PodLib } from \"pod/mpc/PodLib.sol\";"

