#!/usr/bin/env node
// Run: node scripts/generate-vapid.js
const webPush = require('web-push');
const keys = webPush.generateVAPIDKeys();
console.log('Add these to your .env / Vercel environment variables:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
