// src/services/ArgoVisorApi.js
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { ArgoVisor } = require('./ArgoVisor');
const config = require('../../config/config');

const app = express();
const port = process.env.PORT || config.server.port;

// Excluded applications list
const EXCLUDED_APPS = process.env.EXCLUDED_APPS ? 
    process.env.EXCLUDED_APPS.split(',') : 
    ['argocd-apps', 'argocd-initialize'];

// Middleware
app.use(compression());
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? 
        process.env.ALLOWED_ORIGINS.split(',') : 
        ['http://localhost:8080'],
    methods: ['GET', 'POST'],
    credentials: true,
    exposedHeaders: ['Content-Length', 'Content-Type'],
}));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
    console.info(`${req.method} ${req.url}`);
    next();
});

const monitor = new ArgoVisor(config.clusters, config.slack.webhookUrl);

function calculateFilteredMetrics(clusters) {
    const metrics = {
        totalApps: 0,
        healthyApps: 0,
        syncedApps: 0,
        degradedApps: 0,
        failedApps: 0,
        outOfSyncApps: 0,
        unknownApps: 0,
        processingApps: 0
    };

    clusters.forEach(cluster => {
        const filteredApps = (cluster.applications || []).filter(app => 
            !EXCLUDED_APPS.includes(app.name)
        );

        filteredApps.forEach(app => {
            metrics.totalApps++;
            
            // Health status metrics
            if (app.healthStatus === 'Healthy') metrics.healthyApps++;
            if (app.healthStatus === 'Degraded') metrics.degradedApps++;
            if (app.healthStatus === 'Failed') metrics.failedApps++;
            if (app.healthStatus === 'Unknown') metrics.unknownApps++;
            
            // Sync status metrics
            if (app.syncStatus === 'Synced') metrics.syncedApps++;
            if (app.syncStatus === 'OutOfSync') metrics.outOfSyncApps++;
            if (app.syncStatus === 'Processing') metrics.processingApps++;
        });
    });

    return metrics;
}

// API Endpoints
app.get('/test', (req, res) => {
    const state = monitor.getGlobalState();
    res.json({
        status: 'API is working',
        lastUpdate: state.lastUpdate,
        clusterCount: Object.keys(config.clusters).length
    });
});

app.get('/metrics', (req, res) => {
    console.info('Metrics endpoint called');

    const state = monitor.getGlobalState();
    if (!state.metrics) {
        return res.status(503).json({
            error: 'Data not ready yet'
        });
    }

    const filteredMetrics = calculateFilteredMetrics(state.clusters);
    res.json(filteredMetrics);
});

app.get('/applications', async (req, res) => {
    try {
        console.info('Applications endpoint called');
        const state = monitor.getGlobalState();
        
        if (!state.clusters) {
            return res.status(503).json({
                error: 'Data not ready yet'
            });
        }

        const formattedClusters = state.clusters.map(cluster => ({
            name: cluster.name,
            url: cluster.url,
            applications: (cluster.applications || []).filter(app => 
                !EXCLUDED_APPS.includes(app.name)
            )
        }));

        res.header('Access-Control-Allow-Origin', '*');
        res.json(formattedClusters);
    } catch (error) {
        console.error('Error fetching applications:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/status', (req, res) => {
    const updateStatus = monitor.getUpdateStatus();
    res.json(updateStatus);
});

app.post('/refresh', async (req, res) => {
    try {
        await monitor.forceRefresh();
        const state = monitor.getGlobalState();
        res.json({
            message: 'Refresh completed',
            lastUpdate: state.lastUpdate
        });
    } catch (error) {
        console.error('Refresh error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/clusters/:name/sync', async (req, res) => {
    const { name } = req.params;
    try {
        const cluster = config.clusters[name];
        if (!cluster) {
            return res.status(404).json({ error: 'Cluster not found' });
        }

        await monitor.refreshData();
        res.json({ message: `Sync initiated for cluster ${name}` });
    } catch (error) {
        console.error(`Sync error for cluster ${name}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Server initialization
app.listen(port, () => {
    console.info(`API server running on port ${port}`);
});

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

process.on('SIGINT', () => {
    console.info('Server shutting down...');
    process.exit(0);
});