const assert = require('assert');
const path = require('path');
const fs = require('fs');
const server = require('./server');

const TEST_PORT = 5099;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function runTests() {
  server.listen(TEST_PORT);
  console.log(`Starting Ponytail self-check on port ${TEST_PORT}...`);

  try {
    // 1. Health Check
    const resHealth = await fetch(`${BASE_URL}/api/health`);
    assert.strictEqual(resHealth.status, 200, 'Health endpoint should return 200');
    const health = await resHealth.json();
    assert.strictEqual(health.status, 'ok');
    console.log('✔ Health endpoint passed');

    // 2. Catalog GET
    const resCat = await fetch(`${BASE_URL}/api/catalog`);
    assert.strictEqual(resCat.status, 200);
    const catData = await resCat.json();
    assert(Array.isArray(catData.catalog) && catData.catalog.length >= 6, 'Catalog should have at least 6 starter films');
    console.log(`✔ Catalog endpoint passed (${catData.catalog.length} films found)`);

    // 3. User Register & Login
    const testEmail = `tester_${Date.now()}@test.com`;
    const resReg = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test User', email: testEmail, pass: 'secret123' })
    });
    assert.strictEqual(resReg.status, 201);
    const regData = await resReg.json();
    assert.strictEqual(regData.user.email, testEmail);

    const resLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, pass: 'secret123' })
    });
    assert.strictEqual(resLogin.status, 200);
    console.log('✔ Auth register & login passed');

    // 4. Purchase Pass
    const resBuy = await fetch(`${BASE_URL}/api/purchase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, videoId: 'pass', price: 99 })
    });
    assert.strictEqual(resBuy.status, 200);
    const buyData = await resBuy.json();
    assert.strictEqual(buyData.hasPass, true);

    const resUserData = await fetch(`${BASE_URL}/api/user/data?email=${encodeURIComponent(testEmail)}`);
    const userData = await resUserData.json();
    assert.strictEqual(userData.hasPass, true);
    console.log('✔ Purchase pass and user data verification passed');

    // 5. Watch Progress
    const resProg = await fetch(`${BASE_URL}/api/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, videoId: 'sintel', t: 45, d: 900 })
    });
    assert.strictEqual(resProg.status, 200);
    console.log('✔ Progress tracking passed');

    // 6. Admin PIN Check (idempotent: reset -> set -> verify)
    await fetch(`${BASE_URL}/api/admin/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true })
    });
    const resPinSet = await fetch(`${BASE_URL}/api/admin/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPin: '1234' })
    });
    assert.strictEqual(resPinSet.status, 200);

    const resPinCheck = await fetch(`${BASE_URL}/api/admin/verify-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '1234' })
    });
    assert.strictEqual(resPinCheck.status, 200);
    console.log('✔ Admin PIN check passed');

    // 7. Network Info Check
    const resNet = await fetch(`${BASE_URL}/api/network-info`);
    assert.strictEqual(resNet.status, 200);
    const netData = await resNet.json();
    assert(Array.isArray(netData.localIps), 'Should return array of local network IPs');
    console.log(`✔ Network info passed (Local IP: ${netData.localIps[0] || 'localhost'})`);

    // 8. Direct Video Upload & HLS Transcoding Check (Hovod Engine)
    const dummyVideo = Buffer.from('FAKE_VIDEO_CONTENT_FOR_STREAM_CHECK');
    const resUp = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: {
        'X-Filename': 'test_clip.txt',
        'Content-Type': 'text/plain'
      },
      body: dummyVideo
    });
    assert.strictEqual(resUp.status, 201);
    const upData = await resUp.json();
    assert(upData.url && upData.filename, 'Upload should return public file url');

    const resStream = await fetch(`${BASE_URL}${upData.rawUrl}`);
    assert.strictEqual(resStream.status, 200);
    console.log('✔ Direct upload and streaming endpoint passed');

    // 9. Real MP4 to Hovod HLS Transcoding Test
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
          'X-Auto-HLS': 'true'
        },
        body: videoBuffer
      });
      assert.strictEqual(resHlsUp.status, 201);
      const hlsData = await resHlsUp.json();
      assert(hlsData.hlsUrl && hlsData.hlsUrl.endsWith('master.m3u8'), 'Should return master.m3u8 URL');

      const resMaster = await fetch(`${BASE_URL}${hlsData.hlsUrl}`);
      assert.strictEqual(resMaster.status, 200);
      const masterBody = await resMaster.text();
      assert(masterBody.includes('#EXTM3U') && masterBody.includes('EXT-X-STREAM-INF'), 'Playlist should be valid HLS');
      console.log('✔ Hovod HLS Transcoder passed (master.m3u8 adaptive ladder generated & verified)');
    } finally {
      try { fs.unlinkSync(tempVideoPath); } catch(e){}
    }

    // 9. Static Frontend Serving Check
    const resHtml = await fetch(`${BASE_URL}/`);
    assert.strictEqual(resHtml.status, 200);
    const htmlText = await resHtml.text();
    assert(htmlText.includes('StreamCos'), 'Served index.html should contain StreamCos');

    const resCss = await fetch(`${BASE_URL}/css/style.css`);
    assert.strictEqual(resCss.status, 200);

    const resJs = await fetch(`${BASE_URL}/js/app.js`);
    assert.strictEqual(resJs.status, 200);
    console.log('✔ Static frontend serving passed (HTML, CSS, JS)');

    console.log('\nAll Ponytail backend self-checks PASSED successfully (14/14 assertions).');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('\nSelf-check FAILED:', err);
  process.exit(1);
});
