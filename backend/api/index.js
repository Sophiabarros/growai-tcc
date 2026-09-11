// Entrypoint serverless da Vercel: reaproveita o mesmo app Express de
// server.js. As rotas já vêm montadas em /api/*, e o backend/vercel.json
// redireciona todas as requisições para cá.
module.exports = require("../server");
