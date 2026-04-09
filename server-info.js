#!/usr/bin/env node
const http = require('http');
const { exec } = require('child_process');

const PORT = 18793;

function getServerInfo(callback) {
  exec("free -h | grep Mem | awk '{print $3\"/\"$2}' && df -h / | tail -1 | awk '{print $5}' && top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1", 
    (error, stdout) => {
      if (error) {
        callback({ memory: '--', disk: '--', cpu: '--' });
        return;
      }
      const lines = stdout.trim().split('\n');
      callback({
        memory: lines[0] || '--',
        disk: lines[1] || '--',
        cpu: lines[2] ? lines[2] + '%' : '--'
      });
    });
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/server-info' && req.method === 'GET') {
    getServerInfo((data) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server info API running on http://127.0.0.1:${PORT}`);
});
