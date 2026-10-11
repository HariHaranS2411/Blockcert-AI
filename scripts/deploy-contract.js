'use strict';

/**
 * Compiles contracts/CertificateRegistry.sol with solc and deploys it to the
 * configured RPC endpoint with ethers.
 *
 * Usage:
 *   1. Start a local chain:  npm run chain        (Ganache on :7545)
 *   2. Set BLOCKCHAIN_RPC_URL and BLOCKCHAIN_PRIVATE_KEY in .env
 *   3. npm run contract:deploy
 *   4. Copy the printed CONTRACT_ADDRESS into .env
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

function compile() {
  const contractPath = path.join(__dirname, '..', 'contracts', 'CertificateRegistry.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: { 'CertificateRegistry.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    console.error('Compilation failed:');
    for (const e of errors) console.error('  ' + e.formattedMessage);
    process.exit(1);
  }
  const contract = output.contracts['CertificateRegistry.sol']['CertificateRegistry'];
  return { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
}

async function main() {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  const privateKey = process.env.BLOCKCHAIN_PRIVATE_KEY;

  if (!rpcUrl) {
    console.error('BLOCKCHAIN_RPC_URL is not configured. Set it in .env (e.g. http://127.0.0.1:7545).');
    process.exit(1);
  }
  if (!privateKey) {
    console.error('BLOCKCHAIN_PRIVATE_KEY is not configured. Set it in .env (the Ganache account that will issue certificates).');
    process.exit(1);
  }

  console.log('Compiling CertificateRegistry.sol...');
  const { abi, bytecode } = compile();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  console.log(`Deployer: ${wallet.address} (balance: ${ethers.formatEther(balance)})`);
  if (balance === 0n) {
    console.error('The deployer account has zero balance. Fund it on your local chain (Ganache shows prefunded accounts).');
    process.exit(1);
  }

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log('Deploying...');
  const contract = await factory.deploy();
  const deployTx = contract.deploymentTransaction();
  console.log(`Transaction: ${deployTx.hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await deployTx.wait();

  console.log('');
  console.log('CertificateRegistry deployed.');
  console.log(`  CONTRACT_ADDRESS=${address}`);
  console.log(`  tx hash:         ${deployTx.hash}`);
  console.log(`  block number:    ${receipt.blockNumber}`);
  console.log('');
  console.log('Add CONTRACT_ADDRESS to .env, then restart the server.');
}

main().catch((err) => {
  console.error('Deployment failed:', err.shortMessage || err.message);
  process.exit(1);
});
