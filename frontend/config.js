// Backend address. Local dev (localhost / 127.0.0.1) uses the uvicorn server on port 8010.
window.API_BASE = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:8010'
  : 'https://xiao-iot-api.onrender.com';
