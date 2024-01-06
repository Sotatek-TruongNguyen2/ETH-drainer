require('dotenv').config()
const winston = require('winston');

const ethers = require('ethers');
var clc = require("cli-color");


const { BigNumber } = require('bignumber.js');
const { formatEther } = ethers;

let RPC_INDEX = 0;

const FLASHBOT_RELAYER_CONFIGURATIONS = {
  "5": {
    chainName: "goerli",
    relayerRpc: "https://relay-goerli.flashbots.net"
  },
  "1": {
    chainName: "mainnet",
    relayerRpc: "https://relay.flashbots.net"
  }
}

const logger = new winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  'transports': [
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

const maximumAttempts = process.env.MAXIMUM_ATTEMPS;
const rpcUrls = process.env.WEBSOCKET_RPC_URL.split(",");
const gasFeeMultiplier = process.env.GAS_FEE_MULTIPLIER;
const chainId = process.env.CURRENT_NETWORK_CHAIN_ID;
const flashBotEnabled = process.env.FLASHBOT_ENABLED;


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


const replaceNewRPCUrl = async () => {
  RPC_INDEX++;
  if (RPC_INDEX >= rpcUrls.length) {
    RPC_INDEX = 0;
  }
  console.log(clc.green(`Replace New RPC Url: ${clc.bold(rpcUrls[RPC_INDEX])} \n`));
  main();
}

const transferMoneyToVault = async (jsonProvider, provider, depositWallet) => {
  console.log("RUNNING");
  const currentBalance = await jsonProvider.getBalance(depositWallet.address);

  const txFee = {};

  const feeData = await jsonProvider.getFeeData();
  const gasLimit = 50000

  console.log("current balance: ", currentBalance, feeData);
  // Buff gas fee by X-multiplier
  let maxGasFee = new BigNumber(gasLimit).multipliedBy(feeData.gasPrice).multipliedBy(gasFeeMultiplier);

  if (feeData.lastBaseFeePerGas && feeData.lastBaseFeePerGas.gt(0)) {
    txFee.maxPriorityFeePerGas = new BigNumber(feeData.maxPriorityFeePerGas).multipliedBy(gasFeeMultiplier).toFixed();
    txFee.maxFeePerGas = new BigNumber(feeData.maxFeePerGas).multipliedBy(gasFeeMultiplier).toFixed();
    maxGasFee = new BigNumber(gasLimit).multipliedBy(new BigNumber(txFee.maxFeePerGas.toString()).plus(new BigNumber(txFee.maxPriorityFeePerGas.toString()))).toFixed();
    txFee.type = 2;
  } else {
    txFee.gasPrice = new BigNumber(feeData.gasPrice).multipliedBy(gasFeeMultiplier).toFixed();
    maxGasFee = new BigNumber(gasLimit).multipliedBy(new BigNumber(txFee.gasPrice.toString())).toFixed();
  }

  console.log(clc.blue(`Instantiate transaction for Draining Funds from ${depositWallet.address} ...`));

  const tx = {
    to: process.env.VAULT_WALLET_ADDRESS,
    from: depositWallet.address,
    nonce: await provider.getTransactionCount(depositWallet.address),
    value: `0x${new BigNumber(currentBalance.toString()).minus(maxGasFee).toString(16)}`,
    chainId: Number(chainId),
    gasLimit: gasLimit,
    ...txFee
  }

  console.log("Prepared Tx: ", tx);

  depositWallet.sendTransaction(tx).then(
    (_receipt) => {
      console.log(clc.blue(
        `Withdrew ${clc.bold(formatEther(
          new BigNumber(currentBalance.toString()).minus(maxGasFee).toFixed()
        ))} ETH to VAULT ${clc.bold(process.env.VAULT_WALLET_ADDRESS)} ✅`,
      ))
      console.log(`Withdraw tx hash: ${_receipt.hash}`)
    },
    (reason) => {
      console.error('Withdrawal failed', reason)
    },
  )
}

const main = async () => {
  const provider = new ethers.WebSocketProvider(rpcUrls[RPC_INDEX]);
  const jsonProvider = new ethers.JsonRpcProvider(process.env.JSON_RPC_URL);

  const depositWallet = new ethers.Wallet(
    process.env.DEPOSIT_WALLET_PRIVATE_KEY,
    jsonProvider,
  )

  // @check: Check if flash bot is currently using for sending private tx
  if (flashBotEnabled === false) {
    const flashBotSupportedNetworks = ["1", "5"];


    const existed = flashBotSupportedNetworks.indexOf(chainId);

    if (existed < 0) {
      console.error(`FlashBot doesn't support this network chainID. Please turn off FLASHBOT_ENABLED flag ...`);
      process.exit(0);
    }
  }

  const depositWalletAddress = depositWallet.address;
  console.log(`Watching for incoming tx to ${clc.yellow(depositWalletAddress)}…`)

  provider.on('pending', async (txHash) => {
    let tried = 0;
    try {
      for (let i = 0; i < maximumAttempts; i++) {
        const tx = await provider.getTransaction(txHash);
        if (tried === maximumAttempts) {
          return;
        }

        if (tx === null) {
          tried++;
          await sleep(2000);
          continue;
        }

        const { from, to, value } = tx;

        logger.log('info', `Receiving Tx hash ${txHash} -  ${from} -  ${to} - ${value}`)

        if (ethers.isAddress(to) && ethers.getAddress(to) === ethers.getAddress(depositWalletAddress)) {
          console.log(`Receiving ${formatEther(value)} ETH from ${from}…`)

          console.log(
            `Waiting for ${process.env.CONFIRMATIONS_BEFORE_WITHDRAWAL} confirmations…`,
          )


          await jsonProvider.waitForTransaction(txHash, 1);

          // await tx.wait(process.env.CONFIRMATIONS_BEFORE_WITHDRAWAL).then(
          //   async (_receipt) => {
          //     console.log(_receipt);
          await transferMoneyToVault(provider, jsonProvider, depositWallet);
          // }
          // ).catch(async err => {
          //   console.log(`clc.yellow('Error when waiting for tx confirmation: ${err.message}`);
          //   await transferMoneyToVault(provider, depositWallet);
          // })
        }

        break;
      }
    } catch (err) {
      console.log(clc.red.bold(`Call RPC getTransactionReceipt failed to open due to ${clc.underline(err.message)}, ${txHash}`));
      provider.websocket.terminate();
      replaceNewRPCUrl();
    }
  })

  provider.websocket.on('error', (err) => {
    console.log(clc.red.bold(`Websocket RPC failed to open due to ${clc.underline(err.message)}`));
    replaceNewRPCUrl();
  });

  provider.websocket.on("close", async (code) => {
    provider.websocket.terminate();
  });
}

try {
  main();
} catch (err) {
  console.log(err.message);
}