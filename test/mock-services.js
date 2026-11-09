/**
 * Pretend SiliconDust guide and Channels DVR server, for tests and the demo.
 *   GET /api/guide.php?DeviceAuth=abc   guide for the mock HDHomeRun's channels
 *   GET /api/v1/jobs                    scheduled recordings
 *   GET /api/v1/episodes, /api/v1/movies  recorded items
 */

import http from 'node:http';

const SHOWS = {
  1: ['Breakfast', 'Te Karere', 'TVNZ News at Six', 'Fair Go', 'Country Calendar', 'The Tonight Show'],
  2: ['Shortland Street', 'The Chase', 'MasterChef NZ', 'Coronation Street', 'Grand Designs'],
  3: ['AM', 'ThreeNews', 'The Project', 'Married at First Sight', 'Lego Masters'],
  15: ['Sky Sport Now', 'Rugby: Highlights', 'Cricket Central', 'Movie: The Castle'],
};

function createServices({ port = 18200, jobs } = {}) {
  let jobList = jobs;
  let activity = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const now = Math.floor(Date.now() / 1000);
    if (url.pathname === '/api/guide.php') {
      if (url.searchParams.get('DeviceAuth') !== 'abc') return json({ error: 'bad auth' }, 403);
      const slot = Math.floor(now / 1800) * 1800;
      return json(Object.entries(SHOWS).map(([num, titles]) => ({
        GuideNumber: num,
        GuideName: `Channel ${num}`,
        Guide: titles.map((t, i) => ({ StartTime: slot + (i - 1) * 1800, EndTime: slot + i * 1800, Title: t, EpisodeTitle: i === 1 ? 'Episode 12' : undefined })),
      })));
    }
    if (url.pathname === '/dvr') {
      return json({ version: '2026.10.20', activity });
    }
    if (url.pathname === '/api/v1/channels') {
      return json([
        { number: '1', name: 'TVNZ 1' }, { number: '2', name: 'TVNZ 2' }, { number: '3', name: 'ThreeNow' },
        { number: '104', name: 'Sky News Online' }, { number: '105', name: 'Al Jazeera English' }, { number: '120', name: 'Pluto Movies' },
      ]);
    }
    if (url.pathname === '/devices/ANY/guide/now') {
      const slot = Math.floor(now / 1800) * 1800;
      return json([
        { Channel: { Number: '104' }, Airings: [{ Channel: '104', Time: slot, Duration: 1800, Title: 'World News Live' }] },
        { Channel: { Number: '105' }, Airings: [{ Channel: '105', Time: slot, Duration: 3600, Title: 'Inside Story', EpisodeTitle: 'Climate' }] },
      ]);
    }
    if (url.pathname === '/api/v1/jobs') {
      const list = jobList || defaultJobs(now);
      return json(list);
    }
    if (url.pathname === '/api/v1/episodes') {
      return json([
        { id: '31260', channel: '1', title: 'TVNZ News at Six', episode_title: 'Tuesday', duration: 3600.4, completed: true, created_at: (now - 86400) * 1000 },
        { id: '31261', channel: '2', title: 'Shortland Street', episode_title: 'Episode 8102', duration: 1790, completed: true, created_at: (now - 7200) * 1000 },
      ]);
    }
    if (url.pathname === '/api/v1/movies') {
      return json([{ id: '9001', channel: '15', title: 'The Castle', duration: 5400, completed: true, created_at: (now - 3 * 86400) * 1000 }]);
    }
    json({ error: 'not found' }, 404);
  });
  return {
    setJobs(list) { jobList = list; },
    setActivity(a) { activity = a; },
    start: () => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    stop: () => server.close(),
    url: `http://127.0.0.1:${port}`,
  };
}

function defaultJobs(now) {
  const job = (id, title, start, mins, ch) => ({ id, name: title, start_time: start, end_time: start + mins * 60, duration: mins * 60, channels: [ch], skipped: false, failed: false, item: { title } });
  const h = Math.ceil(now / 3600) * 3600;
  return [
    job('a', 'Fair Go', now - 600, 30, '1'),
    job('b', 'MasterChef NZ', h + 3600, 60, '2'),
    job('c', 'The Project', h + 3600, 30, '3'),
    job('d', 'Country Calendar', h + 3600 + 900, 30, '1'),
    job('e', 'Grand Designs', h + 86400, 60, '2'),
  ];
}

export { createServices };
