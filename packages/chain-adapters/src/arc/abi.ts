/**
 * XebraEscrow ABI, generated via:
 *   cd contracts/arc-evm && forge inspect XebraEscrow abi --json
 *
 * Regenerate after any change to contracts/arc-evm/src/XebraEscrow.sol. Kept as a
 * checked-in `as const` array (not a live forge-artifact import) so this package
 * doesn't need the Foundry toolchain or the contracts workspace as a build dependency.
 */

export const XEBRA_ESCROW_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "_usdc",
        type: "address",
        internalType: "address",
      },
      {
        name: "_arbiter",
        type: "address",
        internalType: "address",
      },
      {
        name: "_challengeWindow",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "BOND_BPS",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "BPS_DENOMINATOR",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MIN_BOND",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "RESOLVE_TIMEOUT",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "arbiter",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "bondsOwed",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "challenge",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "challengeWindow",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "challengedAt",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "challengedAt",
        type: "uint64",
        internalType: "uint64",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claim",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "stellarTxHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "deliveredAmount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "eip712Domain",
    inputs: [],
    outputs: [
      {
        name: "fields",
        type: "bytes1",
        internalType: "bytes1",
      },
      {
        name: "name",
        type: "string",
        internalType: "string",
      },
      {
        name: "version",
        type: "string",
        internalType: "string",
      },
      {
        name: "chainId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "verifyingContract",
        type: "address",
        internalType: "address",
      },
      {
        name: "salt",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "extensions",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "escrows",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "user",
        type: "address",
        internalType: "address",
      },
      {
        name: "sourceToken",
        type: "address",
        internalType: "address",
      },
      {
        name: "sourceAmount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "expiry",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "status",
        type: "uint8",
        internalType: "enum XebraEscrow.Status",
      },
      {
        name: "solver",
        type: "address",
        internalType: "address",
      },
      {
        name: "stellarTxHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "deliveredAmount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "solverBond",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "claimedAt",
        type: "uint64",
        internalType: "uint64",
      },
      {
        name: "challenger",
        type: "address",
        internalType: "address",
      },
      {
        name: "challengerBond",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "expireChallenge",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "finalize",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "hashIntent",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        internalType: "struct XebraEscrow.Intent",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address",
          },
          {
            name: "sourceToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "sourceAmount",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "destAsset",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "minDestAmount",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "destAddress",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "expiry",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lastNonce",
    inputs: [
      {
        name: "user",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "lastNonce",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "open",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        internalType: "struct XebraEscrow.Intent",
        components: [
          {
            name: "user",
            type: "address",
            internalType: "address",
          },
          {
            name: "sourceToken",
            type: "address",
            internalType: "address",
          },
          {
            name: "sourceAmount",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "destAsset",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "minDestAmount",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "destAddress",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "expiry",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
      {
        name: "signature",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "refund",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "requiredBond",
    inputs: [
      {
        name: "sourceAmount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "resolve",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
      {
        name: "claimValid",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "statusOf",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "enum XebraEscrow.Status",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "usdc",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "withdrawBonds",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address payable",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "BondCredited",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BondsWithdrawn",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ChallengeExpired",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "EIP712DomainChanged",
    inputs: [],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentChallenged",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "challenger",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "challengerBond",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentClaimed",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "solver",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "stellarTxHash",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "deliveredAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "solverBond",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "challengeDeadline",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentFinalized",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "solver",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "sourceAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentOpened",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "user",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "sourceToken",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "sourceAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "destAsset",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "minDestAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "destAddress",
        type: "bytes32",
        indexed: false,
        internalType: "bytes32",
      },
      {
        name: "expiry",
        type: "uint64",
        indexed: false,
        internalType: "uint64",
      },
      {
        name: "nonce",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentRefunded",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "sourceAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "IntentResolved",
    inputs: [
      {
        name: "intentHash",
        type: "bytes32",
        indexed: true,
        internalType: "bytes32",
      },
      {
        name: "claimValid",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "BadSignature",
    inputs: [],
  },
  {
    type: "error",
    name: "ChallengeWindowClosed",
    inputs: [],
  },
  {
    type: "error",
    name: "ChallengeWindowOpen",
    inputs: [],
  },
  {
    type: "error",
    name: "ECDSAInvalidSignature",
    inputs: [],
  },
  {
    type: "error",
    name: "ECDSAInvalidSignatureLength",
    inputs: [
      {
        name: "length",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "ECDSAInvalidSignatureS",
    inputs: [
      {
        name: "s",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
  },
  {
    type: "error",
    name: "IncorrectBond",
    inputs: [
      {
        name: "required",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "provided",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "IntentAlreadyExists",
    inputs: [],
  },
  {
    type: "error",
    name: "IntentExpired",
    inputs: [],
  },
  {
    type: "error",
    name: "IntentNotExpired",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidShortString",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidSourceToken",
    inputs: [],
  },
  {
    type: "error",
    name: "NativeTransferFailed",
    inputs: [],
  },
  {
    type: "error",
    name: "NonceTooLow",
    inputs: [],
  },
  {
    type: "error",
    name: "NotArbiter",
    inputs: [],
  },
  {
    type: "error",
    name: "NotChallenged",
    inputs: [],
  },
  {
    type: "error",
    name: "NotClaimed",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOpen",
    inputs: [],
  },
  {
    type: "error",
    name: "NothingOwed",
    inputs: [],
  },
  {
    type: "error",
    name: "ReentrancyGuardReentrantCall",
    inputs: [],
  },
  {
    type: "error",
    name: "ResolveTimeoutNotReached",
    inputs: [],
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "StringTooLong",
    inputs: [
      {
        name: "str",
        type: "string",
        internalType: "string",
      },
    ],
  },
  {
    type: "error",
    name: "ZeroAddress",
    inputs: [],
  },
] as const;
