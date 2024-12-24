// config/config.js
const clusters = require('./clusters');

const config = {
    server: {
        port: process.env.PORT || 3000,
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
            credentials: true
        }
    },
    clusters,
    slack: {
        webhookUrl: process.env.SLACK_WEBHOOK_URL,
    }
};

module.exports = config;