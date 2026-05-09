<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=1,6,30&height=180&section=header&text=GasRun&fontSize=56&fontColor=000000&fontAlignY=38&desc=On-chain+car+lane-runner+game+on+Base+with+global+leaderboard&descAlignY=58&descSize=14&animation=fadeIn" width="100%"/>

<div align="center">

[![Play](https://img.shields.io/badge/Play%20Now-bbf7d0?style=for-the-badge&logoColor=000)](https://www.gasrun.online)
[![License](https://img.shields.io/badge/MIT-bfdbfe?style=for-the-badge&logoColor=000)](LICENSE)
[![Platform](https://img.shields.io/badge/Farcaster%20Mini%20App-fde68a?style=for-the-badge&logoColor=000)]()
[![Tech](https://img.shields.io/badge/JavaScript%20%2B%20Base-fca5a5?style=for-the-badge&logoColor=000)]()

</div>

<div align="center">
<i>A lane-runner car game built as a Farcaster mini app on Base .... dodge traffic, score points, and commit your score permanently on-chain.</i>
</div>

---

## ✦ Features

<div align="center">

| | Feature | What it does |
|:---:|---|---|
| 🚗 | Lane-runner gameplay | Dodge incoming traffic across lanes, score based on distance |
| ⛓️ | On-chain score commits | Write your final score to Base Mainnet via smart contract |
| 🏆 | Global leaderboard | Weekly and all-time boards sourced from on-chain logs |
| 🔑 | Wallet connect | WalletConnect + injected wallet support |
| ⛽ | Gasless transactions | Paymaster endpoint for gasless score submissions |
| 📱 | Farcaster native | Runs inside Warpcast / Base app as a mini app |
| 📊 | Redis-cached leaderboard | Instant board load from Redis cache |

</div>

---

## ✦ Download & Run

**Step 1** .... Clone the repo

```bash
git clone https://github.com/0xnurrabby/GasRun
cd GasRun
```

**Step 2** .... Install and configure

```bash
npm install
# Create a .env file with required vars (see Setup)
```

**Step 3** .... Start dev server

```bash
npm run dev
# Or just open index.html in a browser (no build step needed)
# All game logic is in src/main.js (vanilla JS)
```

---

## ✦ Setup

```
1. Clone the repo and run npm install
2. Create a .env file with:
   UPSTASH_REDIS_REST_URL=your_url
   UPSTASH_REDIS_REST_TOKEN=your_token
   NEYNAR_API_KEY=your_key   (optional, for FC usernames on leaderboard)
   MAINTENANCE_MODE=false
3. Run npm run dev for local dev
4. To deploy: push to GitHub and import in vercel.com
   No build step needed - Vercel serves static files directly
5. Game is also live at https://www.gasrun.online
```

---

## ✦ Project Structure

```
GasRun/
  api/
    leaderboard.js    ->  weekly/all-time leaderboard with Redis cache
    paymaster.js      ->  gasless transaction endpoint
    share.js          ->  share card generator
    cron/             ->  scheduled leaderboard cache refresh
  src/
    main.js           ->  full game engine + wallet + on-chain logic
    styles.css        ->  game UI styles
  assets/             ->  sprites, icons, OG images
  .well-known/        ->  Farcaster app manifest
  index.html          ->  mini app entry point
  middleware.js       ->  Vercel edge middleware
  package.json
```

---

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=1,6,30&height=100&section=footer&animation=fadeIn" width="100%"/>

<div align="center">MIT License .... built by <a href="https://github.com/0xnurrabby">0xnurrabby</a></div>
