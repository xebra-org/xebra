// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title XebraEscrow
/// @notice Arc-side escrow for Xebra intents. Source chain leg of the Arc -> Stellar corridor
///         (see /docs xebra-spec_051150). User escrows USDC by signing an EIP-712 Intent; a
///         permissionless, bonded solver claims it by asserting delivery on Stellar; a single
///         v1 admin arbiter resolves disputes. Everything else (open/claim/challenge/finalize/
///         refund) is permissionless by construction.
/// @dev Arc's native gas token is USDC-denominated 1:1 with the ERC-20 USDC used for
///      `sourceAmount` (both 6 decimals), which is what makes it valid to size solver/challenger
///      bonds as a percentage of `sourceAmount` and collect them via `msg.value` with no price
///      oracle in the core path — the "no oracle" property from the spec extends to bonds, not
///      just to `minDestAmount`.
contract XebraEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Intent {
        address user; // refund recipient on Arc
        address sourceToken; // USDC contract on Arc
        uint256 sourceAmount; // 6 decimals
        bytes32 destAsset; // sha256(assetCode || issuerAccountId), zero for native XLM
        uint256 minDestAmount; // 7 decimals, Stellar native precision
        bytes32 destAddress; // Stellar ed25519 public key, raw 32 bytes
        uint64 expiry; // unix seconds
        uint256 nonce; // per-user, strictly increasing
    }

    enum Status {
        None,
        Open,
        Claimed,
        Challenged,
        Finalized,
        Refunded
    }

    struct EscrowEntry {
        address user;
        address sourceToken;
        uint256 sourceAmount;
        uint64 expiry;
        Status status;
        address solver;
        bytes32 stellarTxHash;
        uint256 deliveredAmount;
        uint256 solverBond;
        uint64 claimedAt;
        address challenger;
        uint256 challengerBond;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address user,address sourceToken,uint256 sourceAmount,bytes32 destAsset,uint256 minDestAmount,bytes32 destAddress,uint64 expiry,uint256 nonce)"
    );

    /// @dev Solver/challenger bond = max(sourceAmount * BOND_BPS / 10_000, MIN_BOND).
    uint256 public constant BOND_BPS = 1_000; // 10%
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @dev 25 USDC, 6 decimals — spec's "minimum 25 USDC equivalent".
    uint256 public constant MIN_BOND = 25e6;
    /// @dev How long a challenge may wait for the arbiter before anyone can unwind it
    ///      (`expireChallenge`): the user gets the escrowed USDC back and each side its own bond.
    ///      A backstop for a lost or absent arbiter key, so no escrow can stay frozen forever.
    uint256 public constant RESOLVE_TIMEOUT = 30 days;

    // ---------------------------------------------------------------------
    // Immutable config
    // ---------------------------------------------------------------------

    /// @notice USDC contract intents must reference as `sourceToken`. Constraining this at
    ///         deploy time (rather than trusting whatever address the signed intent names)
    ///         prevents a malicious/buggy `sourceToken` from ever reaching `transferFrom`.
    address public immutable usdc;

    /// @notice v1's single trusted role, used only when a challenge lands. Named honestly as
    ///         the one trusted component (see spec "Trust model"); swappable for Tholos later.
    address public immutable arbiter;

    /// @notice Seconds an unchallenged claim must sit before `finalize` — 30 min testnet /
    ///         24h mainnet per spec, set once at deploy time.
    uint256 public immutable challengeWindow;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 intentHash => EscrowEntry) public escrows;
    mapping(address user => uint256 lastNonce) public lastNonce;
    /// @notice When each escrow was challenged; starts the `RESOLVE_TIMEOUT` clock. Kept out of
    ///         `EscrowEntry` so the `escrows` getter's shape stays the same for existing readers.
    mapping(bytes32 intentHash => uint64 challengedAt) public challengedAt;
    /// @notice Native bonds each address can withdraw. Bonds are credited here, never pushed,
    ///         so an address that refuses payment can only block its own withdrawal, never a
    ///         ruling, a finalize, or a user's refund (GHSA-fc4m-748v-rffc).
    mapping(address account => uint256 amount) public bondsOwed;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event IntentOpened(
        bytes32 indexed intentHash,
        address indexed user,
        address sourceToken,
        uint256 sourceAmount,
        bytes32 destAsset,
        uint256 minDestAmount,
        bytes32 destAddress,
        uint64 expiry,
        uint256 nonce
    );
    event IntentClaimed(
        bytes32 indexed intentHash,
        address indexed solver,
        bytes32 stellarTxHash,
        uint256 deliveredAmount,
        uint256 solverBond,
        uint64 challengeDeadline
    );
    event IntentChallenged(bytes32 indexed intentHash, address indexed challenger, uint256 challengerBond);
    event IntentResolved(bytes32 indexed intentHash, bool claimValid);
    event IntentFinalized(bytes32 indexed intentHash, address indexed solver, uint256 sourceAmount);
    event IntentRefunded(bytes32 indexed intentHash, address indexed to, uint256 sourceAmount);
    event ChallengeExpired(bytes32 indexed intentHash);
    event BondCredited(bytes32 indexed intentHash, address indexed account, uint256 amount);
    event BondsWithdrawn(address indexed account, address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error InvalidSourceToken();
    error IntentExpired();
    error IntentNotExpired();
    error NonceTooLow();
    error IntentAlreadyExists();
    error BadSignature();
    error NotOpen();
    error NotClaimed();
    error NotChallenged();
    error IncorrectBond(uint256 required, uint256 provided);
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error NotArbiter();
    error NativeTransferFailed();
    error ResolveTimeoutNotReached();
    error NothingOwed();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address _usdc, address _arbiter, uint256 _challengeWindow) EIP712("Xebra", "1") {
        if (_usdc == address(0) || _arbiter == address(0)) revert ZeroAddress();
        usdc = _usdc;
        arbiter = _arbiter;
        challengeWindow = _challengeWindow;
    }

    // ---------------------------------------------------------------------
    // Core state machine
    // ---------------------------------------------------------------------

    /// @notice Verifies `signature`, pulls `sourceAmount` USDC via `transferFrom`, opens the
    ///         escrow. Permissionless: anyone may submit on the user's behalf as long as the
    ///         EIP-712 signature is valid (e.g. a relay paying the user's Arc gas).
    function open(Intent calldata intent, bytes calldata signature) external nonReentrant {
        if (intent.expiry <= block.timestamp) revert IntentExpired();
        if (intent.nonce <= lastNonce[intent.user]) revert NonceTooLow();
        if (intent.sourceToken != usdc) revert InvalidSourceToken();

        bytes32 intentHash = hashIntent(intent);
        if (escrows[intentHash].status != Status.None) revert IntentAlreadyExists();

        address signer = ECDSA.recover(intentHash, signature);
        if (signer != intent.user) revert BadSignature();

        // Effects before the external call (checks-effects-interactions): a reentrant `open`
        // for the same user/nonce fails NonceTooLow before `transferFrom` can run twice.
        lastNonce[intent.user] = intent.nonce;
        escrows[intentHash] = EscrowEntry({
            user: intent.user,
            sourceToken: intent.sourceToken,
            sourceAmount: intent.sourceAmount,
            expiry: intent.expiry,
            status: Status.Open,
            solver: address(0),
            stellarTxHash: bytes32(0),
            deliveredAmount: 0,
            solverBond: 0,
            claimedAt: 0,
            challenger: address(0),
            challengerBond: 0
        });

        IERC20(intent.sourceToken).safeTransferFrom(intent.user, address(this), intent.sourceAmount);

        emit IntentOpened(
            intentHash,
            intent.user,
            intent.sourceToken,
            intent.sourceAmount,
            intent.destAsset,
            intent.minDestAmount,
            intent.destAddress,
            intent.expiry,
            intent.nonce
        );
    }

    /// @notice Solver posts a bond and asserts "I delivered on Stellar in this tx", starting
    ///         the challenge window. `stellarTxHash` + `deliveredAmount` are a falsifiable
    ///         claim, verifiable by anyone against Horizon (see spec "Fulfillment, Stellar
    ///         side") — this contract does not and cannot check them itself.
    function claim(bytes32 intentHash, bytes32 stellarTxHash, uint256 deliveredAmount)
        external
        payable
        nonReentrant
    {
        EscrowEntry storage e = escrows[intentHash];
        if (e.status != Status.Open) revert NotOpen();
        if (block.timestamp > e.expiry) revert IntentExpired();

        uint256 required = requiredBond(e.sourceAmount);
        if (msg.value != required) revert IncorrectBond(required, msg.value);

        e.status = Status.Claimed;
        e.solver = msg.sender;
        e.stellarTxHash = stellarTxHash;
        e.deliveredAmount = deliveredAmount;
        e.solverBond = msg.value;
        e.claimedAt = uint64(block.timestamp);

        emit IntentClaimed(
            intentHash, msg.sender, stellarTxHash, deliveredAmount, msg.value, uint64(block.timestamp) + uint64(challengeWindow)
        );
    }

    /// @notice Anyone may post a matching bond within the challenge window to freeze the claim
    ///         for arbiter resolution. Symmetric stakes: challenger bond == solver bond.
    function challenge(bytes32 intentHash) external payable nonReentrant {
        EscrowEntry storage e = escrows[intentHash];
        if (e.status != Status.Claimed) revert NotClaimed();
        if (block.timestamp > e.claimedAt + challengeWindow) revert ChallengeWindowClosed();
        if (msg.value != e.solverBond) revert IncorrectBond(e.solverBond, msg.value);

        e.status = Status.Challenged;
        e.challenger = msg.sender;
        e.challengerBond = msg.value;
        challengedAt[intentHash] = uint64(block.timestamp);

        emit IntentChallenged(intentHash, msg.sender, msg.value);
    }

    /// @notice v1's single trusted role. Only invoked when a challenge actually lands. Pays the
    ///         escrowed USDC to the honest side and credits it both bonds (withdrawn separately,
    ///         see `bondsOwed`), so the ruling never depends on anyone agreeing to be paid. Every claim is publicly Horizon-
    ///         verifiable, so a dishonest resolution here is provably dishonest, in public,
    ///         permanently (see spec "Trust model").
    function resolve(bytes32 intentHash, bool claimValid) external nonReentrant {
        if (msg.sender != arbiter) revert NotArbiter();
        EscrowEntry storage e = escrows[intentHash];
        if (e.status != Status.Challenged) revert NotChallenged();

        emit IntentResolved(intentHash, claimValid);

        if (claimValid) {
            // Solver told the truth: solver receives the escrowed USDC plus both bonds back.
            address solver = e.solver;
            address sourceToken = e.sourceToken;
            uint256 sourceAmount = e.sourceAmount;
            uint256 bondPayout = e.solverBond + e.challengerBond;

            e.status = Status.Finalized;
            e.solverBond = 0;
            e.challengerBond = 0;

            _creditBond(intentHash, solver, bondPayout);
            IERC20(sourceToken).safeTransfer(solver, sourceAmount);

            emit IntentFinalized(intentHash, solver, sourceAmount);
        } else {
            // Solver lied: user gets their principal back, challenger takes both bonds.
            address user = e.user;
            address sourceToken = e.sourceToken;
            uint256 sourceAmount = e.sourceAmount;
            address challenger = e.challenger;
            uint256 bondPayout = e.solverBond + e.challengerBond;

            e.status = Status.Refunded;
            e.solverBond = 0;
            e.challengerBond = 0;

            _creditBond(intentHash, challenger, bondPayout);
            IERC20(sourceToken).safeTransfer(user, sourceAmount);

            emit IntentRefunded(intentHash, user, sourceAmount);
        }
    }

    /// @notice After an unchallenged window elapses, anyone may finalize: escrowed USDC + bond
    ///         returned to the solver.
    function finalize(bytes32 intentHash) external nonReentrant {
        EscrowEntry storage e = escrows[intentHash];
        if (e.status != Status.Claimed) revert NotClaimed();
        if (block.timestamp <= e.claimedAt + challengeWindow) revert ChallengeWindowOpen();

        address solver = e.solver;
        address sourceToken = e.sourceToken;
        uint256 sourceAmount = e.sourceAmount;
        uint256 bond = e.solverBond;

        e.status = Status.Finalized;
        e.solverBond = 0;

        _creditBond(intentHash, solver, bond);
        IERC20(sourceToken).safeTransfer(solver, sourceAmount);

        emit IntentFinalized(intentHash, solver, sourceAmount);
    }

    /// @notice If the arbiter has not ruled `RESOLVE_TIMEOUT` after a challenge, anyone may
    ///         unwind it: the escrowed USDC goes back to the user and each side is credited its
    ///         own bond. Nobody is slashed, because nobody ruled.
    function expireChallenge(bytes32 intentHash) external nonReentrant {
        EscrowEntry storage e = escrows[intentHash];
        if (e.status != Status.Challenged) revert NotChallenged();
        if (block.timestamp <= uint256(challengedAt[intentHash]) + RESOLVE_TIMEOUT) {
            revert ResolveTimeoutNotReached();
        }

        address user = e.user;
        address sourceToken = e.sourceToken;
        uint256 sourceAmount = e.sourceAmount;
        uint256 solverBond = e.solverBond;
        uint256 challengerBond = e.challengerBond;

        e.status = Status.Refunded;
        e.solverBond = 0;
        e.challengerBond = 0;

        _creditBond(intentHash, e.solver, solverBond);
        _creditBond(intentHash, e.challenger, challengerBond);
        IERC20(sourceToken).safeTransfer(user, sourceAmount);

        emit ChallengeExpired(intentHash);
        emit IntentRefunded(intentHash, user, sourceAmount);
    }

    /// @notice Sends every bond credited to the caller to `to`. A contract that cannot receive
    ///         native payments can name another address.
    function withdrawBonds(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = bondsOwed[msg.sender];
        if (amount == 0) revert NothingOwed();

        bondsOwed[msg.sender] = 0;
        _sendNative(to, amount);

        emit BondsWithdrawn(msg.sender, to, amount);
    }

    /// @notice After expiry with no live claim, anyone may return the escrowed USDC to the
    ///         user — the user doesn't even need to come back themselves.
    function refund(bytes32 intentHash) external nonReentrant {
        EscrowEntry storage e = escrows[intentHash];
        if (e.status != Status.Open) revert NotOpen();
        if (block.timestamp <= e.expiry) revert IntentNotExpired();

        address user = e.user;
        address sourceToken = e.sourceToken;
        uint256 sourceAmount = e.sourceAmount;

        e.status = Status.Refunded;

        IERC20(sourceToken).safeTransfer(user, sourceAmount);

        emit IntentRefunded(intentHash, user, sourceAmount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The EIP-712 digest of `intent` — the single 32-byte spine that identifies this
    ///         escrow entry, travels in the Stellar fulfillment's `memo_hash`, and is what a
    ///         solver's `claim` references.
    function hashIntent(Intent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.user,
                intent.sourceToken,
                intent.sourceAmount,
                intent.destAsset,
                intent.minDestAmount,
                intent.destAddress,
                intent.expiry,
                intent.nonce
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @notice Bond required to `claim` or `challenge` an escrow of `sourceAmount`: 10%,
    ///         floored at 25 USDC-equivalent.
    function requiredBond(uint256 sourceAmount) public pure returns (uint256) {
        uint256 pct = (sourceAmount * BOND_BPS) / BPS_DENOMINATOR;
        return pct > MIN_BOND ? pct : MIN_BOND;
    }

    /// @notice Convenience accessor so callers (tests, indexers, the frontend) don't have to
    ///         destructure the full `escrows` tuple just to branch on lifecycle state.
    function statusOf(bytes32 intentHash) external view returns (Status) {
        return escrows[intentHash].status;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _creditBond(bytes32 intentHash, address account, uint256 amount) private {
        if (amount == 0) return;
        bondsOwed[account] += amount;
        emit BondCredited(intentHash, account, amount);
    }

    function _sendNative(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
