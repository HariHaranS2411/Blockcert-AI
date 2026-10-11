'use strict';

const { ethers } = require('ethers');
const { CertificateRegistryABI } = require('../models/blockchainSchema');

let provider = null;
let wallet = null;
let contract = null;
let initError = null;
let checked = false;

/**
 * Initialize the blockchain connection from environment variables.
 * Never throws: absence of configuration must degrade to an honest
 * "unavailable" state in the UI, never to a fake success.
 */
function initBlockchain() {
  initError = null;
  contract = null;
  provider = null;
  wallet = null;
  checked = false;

  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  const privateKey = process.env.BLOCKCHAIN_PRIVATE_KEY;
  const contractAddress = process.env.CONTRACT_ADDRESS;

  if (!rpcUrl) {
    initError = 'BLOCKCHAIN_RPC_URL is not configured.';
    return null;
  }
  try {
    provider = new ethers.JsonRpcProvider(rpcUrl);
  } catch (err) {
    initError = 'Blockchain RPC URL is invalid.';
    provider = null;
    return null;
  }

  if (privateKey) {
    try {
      // NonceManager serialises nonce allocation for back-to-back transactions
      // (e.g. bulk issuance) so concurrent sends never reuse a stale nonce.
      wallet = new ethers.NonceManager(new ethers.Wallet(privateKey, provider));
    } catch (err) {
      initError = 'BLOCKCHAIN_PRIVATE_KEY is not a valid private key.';
      wallet = null;
    }
  }

  if (contractAddress) {
    if (!ethers.isAddress(contractAddress)) {
      initError = 'CONTRACT_ADDRESS is not a valid address.';
    } else if (!wallet) {
      // Read-only contract still works without a key (verify/get calls).
      contract = new ethers.Contract(contractAddress, CertificateRegistryABI, provider);
    } else {
      contract = new ethers.Contract(contractAddress, CertificateRegistryABI, wallet);
    }
  }

  return contract;
}

function isBlockchainConfigured() {
  return Boolean(contract);
}

function isSignerConfigured() {
  return Boolean(contract && wallet);
}

/** Returns an honest reason string when the chain cannot be used, else null. */
function getUnavailableReason() {
  if (!provider) return initError || 'Blockchain verification is currently unavailable.';
  if (!process.env.CONTRACT_ADDRESS) return 'Smart contract address is not configured.';
  if (!contract) return initError || 'Blockchain verification is currently unavailable.';
  return null;
}

function getProvider() {
  if (!provider) throw unavailableError();
  return provider;
}

function getWallet() {
  if (!wallet) {
    const e = new Error('Blockchain signing key is not configured.');
    e.code = 'BLOCKCHAIN_UNAVAILABLE';
    throw e;
  }
  return wallet;
}

function getContract() {
  const reason = getUnavailableReason();
  if (reason) {
    const e = new Error(reason);
    e.code = 'BLOCKCHAIN_UNAVAILABLE';
    throw e;
  }
  return contract;
}

function unavailableError() {
  const e = new Error(getUnavailableReason() || 'Blockchain verification is currently unavailable.');
  e.code = 'BLOCKCHAIN_UNAVAILABLE';
  return e;
}

/** Real connectivity probe against the configured RPC endpoint. */
async function checkBlockchainHealth() {
  if (!provider) {
    return { configured: false, connected: false, message: initError || 'Blockchain RPC is not configured.' };
  }
  try {
    const network = await provider.getNetwork();
    const blockNumber = await provider.getBlockNumber();
    return {
      configured: Boolean(contract),
      connected: true,
      network: String(network.name || network.chainId),
      chainId: Number(network.chainId),
      blockNumber,
      contractAddress: process.env.CONTRACT_ADDRESS || null,
      message: contract ? 'Connected.' : 'Connected, but smart contract address is not configured.',
    };
  } catch (err) {
    return {
      configured: Boolean(contract),
      connected: false,
      message: 'Blockchain verification is currently unavailable. ' + (err.shortMessage || err.message || ''),
    };
  }
}

module.exports = {
  initBlockchain,
  getProvider,
  getWallet,
  getContract,
  isBlockchainConfigured,
  isSignerConfigured,
  getUnavailableReason,
  checkBlockchainHealth,
  unavailableError,
};
