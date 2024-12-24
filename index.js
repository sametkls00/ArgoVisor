require('dotenv').config();
const config = require('./config/config');
const app = require('./src/services/ArgoCDApi');

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

process.on('SIGTERM', () => {
    console.info('SIGTERM signal received.');
    console.info('Closing HTTP server...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.info('SIGINT signal received.');
    console.info('Closing HTTP server...');
    process.exit(0);
});

// Startup logging
console.info(`ArgoVisor Backend starting...`);
console.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.info(`Listening on port: ${process.env.PORT || 3000}`);
console.info(`Number of clusters configured: ${Object.keys(config.clusters).length}`);

module.exports = app;