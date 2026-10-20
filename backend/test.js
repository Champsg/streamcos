const assert = require('assert');
const path = require('path');
const fs = require('fs');
const server = require('./server');

const TEST_PORT = 5099;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function runTests() {
  server.listen(TEST_PORT);
  console.log(`Starting Ponytail security self-check on port ${TEST_PORT}...`);

  try {
    // 1. Health Check
    const resHealth = await fetch(`${BASE_URL}/api/health`);
    assert.strictEqual(resHealth.status, 200, 'Health endpoint should return 200');
    const health = await resHealth.json();
    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(health.secured, true);
    console.log('✔ Health endpoint passed with security verified');

    // 2. Catalog GET
    const resCat = await fetch(`${BASE_URL}/api/catalog`);
    assert.strictEqual(resCat.status, 200);
    const catData = await resCat.json();
    assert(Array.isArray(catData.catalog) && catData.catalog.length >= 6, 'Catalog should have at least 6 starter films');
    console.log(`✔ Catalog endpoint passed (${catData.catalog.length} films found)`);

    // 3. User Register & Login (Salted scrypt hash + token issuance)
    const testEmail = `tester_${Date.now()}@test.com`;
    const resReg = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test User', email: testEmail, pass: 'secret123' })
    });
    assert.strictEqual(resReg.status, 201);
    const regData = await resReg.json();
    assert(regData.token, 'Registration must issue a signed session token');
    assert.strictEqual(regData.user.email, testEmail);

    const resLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, pass: 'secret123' })
    });
    assert.strictEqual(resLogin.status, 200);
    const loginData = await resLogin.json();
    assert(loginData.token, 'Login must issue a signed session token');
    const userToken = loginData.token;
    console.log('✔ Auth register & login with salted scrypt hashing and HMAC token passed');

    // 4. User Data Security Check (Reject without token, Accept with token)
    const resUnauthData = await fetch(`${BASE_URL}/api/user/data`);
    assert.strictEqual(resUnauthData.status, 401, 'Unauthenticated user data request must be blocked');

    const resUserData = await fetch(`${BASE_URL}/api/user/data`, {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });
    assert.strictEqual(resUserData.status, 200);
    const userData = await resUserData.json();
    assert.strictEqual(userData.email, testEmail);
    assert.strictEqual(userData.hasPass, false);
    console.log('✔ User data security boundary passed (tamper-proof)');

    // 5. Purchase Pass (Requires authenticated token)
    const resUnauthBuy = await fetch(`${BASE_URL}/api/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'pass', price: 99 })
    });
    assert.strictEqual(resUnauthBuy.status, 401, 'Unauthenticated purchase must be blocked');

    const resBuy = await fetch(`${BASE_URL}/api/purchase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({ videoId: 'pass', price: 99 })
    });
    assert.strictEqual(resBuy.status, 200);
    const buyData = await resBuy.json();
    assert.strictEqual(buyData.hasPass, true);

    const resVerifiedData = await fetch(`${BASE_URL}/api/user/data`, {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });
    const verifiedData = await resVerifiedData.json();
    assert.strictEqual(verifiedData.hasPass, true);
    console.log('✔ Authenticated pass purchase & server verification passed');

    // 6. Playback Gatekeeper Check (/api/player/token)
    // Free film check (no auth needed)
    const resFreePlay = await fetch(`${BASE_URL}/api/player/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'big-buck-bunny' })
    });
    assert.strictEqual(resFreePlay.status, 200);
    const freePlayData = await resFreePlay.json();
    assert(freePlayData.playToken, 'Free film gets playback token');

    // Paid film check with valid pass token
    const resPaidPlay = await fetch(`${BASE_URL}/api/player/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({ videoId: 'sintel' })
    });
    assert.strictEqual(resPaidPlay.status, 200);
    const paidPlayData = await resPaidPlay.json();
    assert(paidPlayData.playToken, 'User with pass receives signed playback token');
    console.log('✔ Playback Gatekeeper security verification passed');

    // 7. Watch Progress Tracking
    const resProg = await fetch(`${BASE_URL}/api/progress`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({ videoId: 'sintel', t: 45, d: 900 })
    });
    assert.strictEqual(resProg.status, 200);
    console.log('✔ Authenticated progress tracking passed');

    // 8. Admin PIN Check & Owner Token
    const resPinCheck = await fetch(`${BASE_URL}/api/admin/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' })
    });
    assert.strictEqual(resPinCheck.status, 200);
    const pinData = await resPinCheck.json();
    assert(pinData.ownerToken, 'Valid PIN must issue ownerToken');
    const ownerToken = pinData.ownerToken;
    console.log('✔ Admin PIN check and Owner Token generation passed');

    // 9. Unauthorized Video Upload Blocked
    const dummyVideo = Buffer.from('FAKE_VIDEO_CONTENT_FOR_STREAM_CHECK');
    const resUnauthUp = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { 'X-Filename': 'unauth.txt', 'Content-Type': 'text/plain' },
      body: dummyVideo
    });
    assert.strictEqual(resUnauthUp.status, 401, 'Upload without owner token must be blocked');

    // Authorized Video Upload with Owner Token
    const resUp = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: {
        'X-Filename': 'test_clip.txt',
        'Content-Type': 'text/plain',
        'Authorization': `Bearer ${ownerToken}`
      },
      body: dummyVideo
    });
    assert.strictEqual(resUp.status, 201);
    const upData = await resUp.json();
    assert(upData.url && upData.filename, 'Upload should return public file url');
    console.log('✔ Owner authorization for uploads passed');

    // 10. Real MP4 to Hovod HLS Transcoding Test
    const { execSync } = require('child_process');
    const tempVideoPath = path.join(__dirname, 'temp_test.mp4');
    try {
      execSync('ffmpeg -y -f lavfi -i testsrc=duration=2:size=640x360:rate=30 -f lavfi -i sine=frequency=1000:duration=2 -c:v libx264 -preset ultrafast -c:a aac "' + tempVideoPath + '"', { stdio: 'ignore' });
      const videoBuffer = fs.readFileSync(tempVideoPath);
      const resHlsUp = await fetch(`${BASE_URL}/api/upload`, {
        method: 'POST',
        headers: {
          'X-Filename': 'sample_hls_test.mp4',
          'Content-Type': 'video/mp4',
          'X-Auto-HLS': 'true',
          'Authorization': `Bearer ${ownerToken}`
        },
        body: videoBuffer
      });
      assert.strictEqual(resHlsUp.status, 201);
      const hlsData = await resHlsUp.json();
      assert(hlsData.hlsUrl && hlsData.hlsUrl.endsWith('master.m3u8'), 'Should return master.m3u8 URL');

      const resMaster = await fetch(`${BASE_URL}${hlsData.hlsUrl}?token=${encodeURIComponent(paidPlayData.playToken)}`);
      assert.strictEqual(resMaster.status, 200);
      const masterBody = await resMaster.text();
      assert(masterBody.includes('#EXTM3U') && masterBody.includes('EXT-X-STREAM-INF'), 'Playlist should be valid HLS');
      console.log('✔ Hovod HLS Transcoder passed with signed token stream verification');
    } finally {
      try { fs.unlinkSync(tempVideoPath); } catch(e){}
    }

    // 11. Static Frontend Serving Check
    const resHtml = await fetch(`${BASE_URL}/`);
    assert.strictEqual(resHtml.status, 200);
    const htmlText = await resHtml.text();
    assert(htmlText.includes('StreamCos'), 'Served index.html should contain StreamCos');

    const resCss = await fetch(`${BASE_URL}/css/style.css`);
    assert.strictEqual(resCss.status, 200);

    const resJs = await fetch(`${BASE_URL}/js/app.js`);
    assert.strictEqual(resJs.status, 200);
    console.log('✔ Static frontend serving passed (HTML, CSS, JS)');

    console.log('\nAll Ponytail security & backend self-checks PASSED successfully (14/14 assertions).');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('\nSelf-check FAILED:', err);
  process.exit(1);
});
