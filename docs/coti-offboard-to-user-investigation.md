# COTI `offBoardToUser` investigation

Empirical probe on COTI testnet using `OffBoardToUserProbe` (`MpcCore.offBoardToUser` on a public `gtUint256`).

Probe plaintext value: **4242424**

## Summary

- **MPC call reverts for non-onboarded `addr`:** no (all `probeOffBoardToUser` transactions succeeded)
- **Charlie pre-onboard all-zero limbs:** no
- **Charlie pre equals system `offBoard`:** no
- **Charlie pre equals plain-zero:** no
- **Charlie pre vs post fingerprint differs:** yes
- **Decrypt Charlie pre-onboard ct with post-onboard key:** ok → 4242424
- **Decrypt Charlie post-onboard ct with post-onboard key:** ok → 4242424

## What is a fingerprint?

A **fingerprint** is a compact string representation of a COTI `ctUint256` ciphertext. It is **not** a cryptographic hash — it does not hide the value. It is simply the four uint64 limbs of the ciphertext, joined with commas:

```text
highHigh,highLow,lowHigh,lowLow
```

`ctUint256` on COTI is stored as four 64-bit chunks. The investigation decodes each sample with `decodeCtUint256` and formats those limbs as decimal strings (see `ctFingerprint` in `test/tokens/offboard-to-user-investigation.ts`).

Example (Charlie pre-onboard):

```text
97180712143359060353391901031104722457559539334859861875888457016106338702249,43415236825285627113543799975003317850274677656206628557901342180115385577850,...
```

Fingerprints let us compare ciphertexts **without decrypting**:

| Question | How to check |
|----------|--------------|
| Are two ciphertexts identical? | Fingerprints match exactly |
| Is the ct uninitialized / all-zero? | Separate **all-zero limbs** column (`highHigh` … `lowLow` all `0`) |
| Does onboard change the blob? | Pre vs post fingerprint differs, even when plaintext is the same |

## Samples

| Label | Address | Onboarded? | All-zero limbs? | Decrypt attempt | Fingerprint (4×uint64 limbs) |
|-------|---------|--------------|-----------------|-----------------|------------------------------|
| onboarded owner | `0xdF9F8FcA4591227C092FCBAb45A846C19fb6d1ae` | yes | no | ok → 4242424 | `15982348490289367099234142846766478608500073176015019728590164811093529307784,786485525485082436…` |
| Charlie pre-onboard | `0xE223178D83E719F93fCED02989D012DE6DB9d0C5` | no | no | skipped (no AES key) | `97180712143359060353391901031104722457559539334859861875888457016106338702249,434152368252856271…` |
| random EOA pre-onboard | `0x000000000000000000000000000000000000d00d` | no | no | skipped (no AES key) | `18750662161240304503434277583156076668769648937216064456872526921465529501199,223452738934551499…` |
| AccountOnboard contract | `0x536A67f0cc46513E7d27a370ed1aF9FDcC7A5095` | no | no | skipped (no AES key) | `93662775835416763517598159934267822601562616071431099835095284106147918257735,114626400028870552…` |
| system offBoard (same value) | `0xdF9F8FcA4591227C092FCBAb45A846C19fb6d1ae` | yes | no | skipped (no AES key) | `89896540104214901175051622942671334392536270669720191996353775843612151305166,269290788498107413…` |
| system offBoard(0) | `0xdF9F8FcA4591227C092FCBAb45A846C19fb6d1ae` | yes | no | skipped (no AES key) | `28680635664834476482279537164543971308550058224525630770490417404892087623255,359586427203501717…` |
| Charlie post-onboard (fresh probe) | `0xE223178D83E719F93fCED02989D012DE6DB9d0C5` | yes | no | ok → 4242424 | `10469574841618734794101342750193816161387887132570343949739754023365615966187,113378492991123177…` |
| Charlie pre-onboard ct + post-onboard AES key | `0xE223178D83E719F93fCED02989D012DE6DB9d0C5` | no | no | ok → 4242424 | `97180712143359060353391901031104722457559539334859861875888457016106338702249,434152368252856271…` |

## Full fingerprints

```text
owner-onboarded: 15982348490289367099234142846766478608500073176015019728590164811093529307784,78648552548508243699465381830331991361133734325520403844488886615786368983854,67287250020733617033813516040008853915332653664710816326530226746741765007511,107841982008159435162887529267949037058518500266811574558690305372769625022334
charlie-pre:     97180712143359060353391901031104722457559539334859861875888457016106338702249,43415236825285627113543799975003317850274677656206628557901342180115385577850,9727924935691960734462118489032413752167484558787744062817645293158115685734,104466243236099100029765903136268374199749619128640635997723648771491427026804
charlie-post:    10469574841618734794101342750193816161387887132570343949739754023365615966187,113378492991123177188494398141842753923809896532713717099034608568294310116708,24205183567309710336046159738244413682811280965459626000772869424679889381663,6867370410404732824976209405322857105375100689100022026705945103663040172908
random-pre:      18750662161240304503434277583156076668769648937216064456872526921465529501199,22345273893455149974833503846018625953559466558037111654263445669597889722756,43348275179170418165184240852150644081054800282996627000757843030478386932931,54409733847530756352698636115252281801729829927994254304071419860890889130638
contract:        93662775835416763517598159934267822601562616071431099835095284106147918257735,114626400028870552075021726036160392205783697828881662138832688801934356777855,13589523106943589735259677322103313031506278292097372090645111947384799979004,14135802898502660393039470960385239218764501871301118060326039712763180870736
system-offBoard: 89896540104214901175051622942671334392536270669720191996353775843612151305166,26929078849810741304261033786530376764927798108536500407736217401642872749684,106296336594036051085183464363670798829576305851361008900831747292071432928690,92280663524546943863579939892614830642115023447942823542475667880509975717702
plain-zero:      28680635664834476482279537164543971308550058224525630770490417404892087623255,35958642720350171792651874721478318980283902041358066160458556550472013867775,61342464549309727132117713801145718940302990228434475990362936336577139159858,18565682439184715331935104324553132334752383622248217125146859269088450929064
```

## Interpretation

### Does `offBoardToUser` revert without onboarding?

No — for this probe, COTI returns a `ctUint256` for every address tested (onboarded EOA, non-onboarded EOA, and a contract address). This matches Privacy Portal withdraw behaviour: `offBoardToUser(..., portalAddress)` runs even though the portal never calls `onboardAccount`.

### What does the ciphertext look like?

For non-onboarded Charlie, limbs were **non-zero** and differed from onboarded-owner and system-offBoard fingerprints.
Non-onboarded ciphertext is a **distinct deterministic blob per `addr`**, neither equal to onboarded-user ct nor necessarily to system offBoard.

### After onboarding

A fresh `offBoardToUser` after `onboardAccount` produces **different ciphertext** that decrypts to the probe value with the user's AES key.

Decrypting the **pre-onboard** ciphertext with the **post-onboard** AES key: ok → 4242424.

### Implications for PoD / Privacy Portal

- **Chain execution:** `offBoardToUser` completes for not-yet-onboarded EOAs and contract addresses (e.g. Privacy Portal on withdraw). No try/catch wrapper is required for mining.
- **Ciphertext shape:** non-onboarded addresses get **non-zero**, **per-address** `ctUint256` limbs (not all-zero, not identical to `offBoard` or to another address).
- **Wallet UX:** onboarding is still required before a client can decrypt — but ciphertext produced **before** `onboardAccount` for that address may decrypt with the AES key obtained **after** onboard (see Charlie pre-onboard row). `syncBalances` remains useful to refresh stored balances when PoD ledger ct was produced under different conditions.
- **Allowance spender view:** spender-side ct from approve may still need re-approve after onboard if decryption fails in practice (see `pod-token-late-onboard` test).

## How to reproduce

```bash
npm run investigate:offboard-to-user
```
