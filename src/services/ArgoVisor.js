// src/services/ArgoVisor.js

const axios = require('axios');
const NodeCache = require('node-cache');
const https = require('https');
const Promise = require('bluebird');

const CACHE_KEYS = {
    GLOBAL_STATE: 'global_state',
    LAST_UPDATE: 'last_update_time'
};

const agent = new https.Agent({
    keepAlive: true,
    maxSockets: Infinity,
    rejectUnauthorized: false
});

const createAxiosInstance = () => axios.create({
    httpsAgent: agent,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 30000,
    headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
    }
});

class ArgoCDCluster {
    constructor(name, url, username, password) {
        this.name = name;
        this.url = url.startsWith('http') ? url.replace(/\/$/, '') : `https://${url}`.replace(/\/$/, '');
        this.username = username;
        this.password = password;
        this.token = null;
        this.lastTokenRefresh = null;
        this.axiosInstance = createAxiosInstance();
    }
}

class ArgoVisor {
    constructor(clusters, slackWebhookUrl) {
        this.clusters = Object.entries(clusters).reduce((acc, [name, config]) => {
            acc[name] = new ArgoCDCluster(name, config.url, config.username, config.password);
            return acc;
        }, {});

        this.slackWebhookUrl = slackWebhookUrl;
        this.axiosInstance = createAxiosInstance();
        this.previousStates = new Map();
        this.previousCounts = new Map();
        this.isUpdating = false;
        this.lastAlerts = new Map();
        this.updateInterval = process.env.UPDATE_INTERVAL || 60000;
        this.alertInterval = process.env.ALERT_INTERVAL || 24 * 60 * 60 * 1000;

        this.globalCache = new NodeCache({
            stdTTL: 60,
            checkperiod: 30,
            useClones: false,
            deleteOnExpire: true
        });

        this.tokenCache = new NodeCache({
            stdTTL: 3500,
            checkperiod: 60,
            deleteOnExpire: true
        });

        console.log(`ArgoVisor initialized - Monitoring ${Object.keys(this.clusters).length} clusters`);
        this.startBackgroundRefresh();
    }

    async start() {
        console.log('ArgoVisor monitoring started...');
        await this.startBackgroundRefresh();
    }

    async startBackgroundRefresh() {
        console.log('Background data refresh initiated');
        await this.refreshData();
        setInterval(async () => {
            await this.refreshData();
        }, this.updateInterval);
    }

    async refreshData() {
        if (this.isUpdating) {
            console.log('Update already in progress');
            return;
        }

        this.isUpdating = true;
        const startTime = Date.now();

        try {
            console.log('Data update started');
            const clusterResults = await this.processClustersInBatches();
            const metrics = this.calculateMetrics(clusterResults);

            const globalState = {
                metrics,
                clusters: clusterResults,
                lastUpdate: new Date().toISOString()
            };

            this.globalCache.set(CACHE_KEYS.GLOBAL_STATE, globalState);

            const duration = Date.now() - startTime;
            console.log(`Data update completed (${duration}ms)`);

            await this.sendSlackUpdates(clusterResults);
        } catch (error) {
            console.error('Data update error:', error);
        } finally {
            this.isUpdating = false;
        }
    }

    getGlobalState() {
        return this.globalCache.get(CACHE_KEYS.GLOBAL_STATE) || {
            metrics: this.getEmptyMetrics(),
            clusters: [],
            lastUpdate: null
        };
    }

    getEmptyMetrics() {
        return {
            totalApps: 0,
            healthyApps: 0,
            syncedApps: 0,
            degradedApps: 0,
            failedApps: 0,
            outOfSyncApps: 0,
            unknownApps: 0,
            processingApps: 0
        };
    }

    async getArgoCDToken(cluster) {
        const cacheKey = `token_${cluster.name}`;
        const cachedToken = this.tokenCache.get(cacheKey);
        if (cachedToken) return cachedToken;

        try {
            const response = await cluster.axiosInstance.post(
                `${cluster.url}/api/v1/session`,
                { username: cluster.username, password: cluster.password }
            );

            if (response.data?.token) {
                this.tokenCache.set(cacheKey, response.data.token, 3500);
                return response.data.token;
            }
            throw new Error('Token not received');
        } catch (error) {
            console.error(`[${cluster.name}] Token error: ${error.message}`);
            throw error;
        }
    }

    async getApplications(cluster) {
        try {
            const token = await this.getArgoCDToken(cluster);
            const response = await cluster.axiosInstance.get(
                `${cluster.url}/api/v1/applications`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Cache-Control': 'no-cache'
                    },
                    decompress: true,
                    timeout: 30000
                }
            );
    
            if (!response.data?.items) {
                console.warn(`[${cluster.name}] Data returned empty`);
                return [];
            }
    
            return response.data.items;
        } catch (error) {
            console.error(`[${cluster.name}] Could not get data: ${error.message}`);
            return [];
        }
    }

    async processCluster(name, cluster) {
        try {
            const apps = await this.getApplications(cluster);
            
            if (!apps || apps.length === 0) {
                console.warn(`[${name}] No applications found or failed to fetch data`);
                const error = new Error(`Failed to fetch applications from cluster ${name}`);
                error.cluster = name;
                throw error;
            }
    
            const mappedApps = apps.map(app => ({
                name: app.metadata?.name || 'Unknown',
                healthStatus: app.status?.health?.status || 'Unknown',
                syncStatus: app.status?.sync?.status || 'Unknown',
                metadata: app.metadata,
                status: app.status,
                spec: app.spec
            }));
    
            console.log(`[${name}] Successfully processed ${mappedApps.length} applications`);
            return { name, url: cluster.url, applications: mappedApps };
        } catch (error) {
            console.error(`[${name}] Process error: ${error.message}`);
            throw error;
        }
    }

    async processClustersInBatches() {
        try {
            const clusterPromises = Object.entries(this.clusters).map(([name, cluster]) =>
                this.processCluster(name, cluster)
                    .catch(error => {
                        console.error(`[${name}] Processing error: ${error.message}`);
                        return { name, url: cluster.url, applications: [] };
                    })
            );

            const results = await Promise.all(clusterPromises);
            console.log(`${results.length} clusters processed successfully`);
            return results;
        } catch (error) {
            console.error(`Batch processing error: ${error.message}`);
            return [];
        }
    }

    async sendSlackMessage(message, clusterUrl = null) {
        try {
            let blocks = [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: message
                    }
                }
            ];
    
            if (clusterUrl) {
                blocks.push({
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "ArgoCD",
                                emoji: true
                            },
                            url: clusterUrl,
                            style: "primary"
                        },
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "ArgoVisor",
                                emoji: true
                            },
                            url: process.env.ARGOVISOR_URL || "http://localhost:3000",
                            style: "primary"
                        }
                    ]
                });
            }
    
            const payload = { blocks };
            await this.axiosInstance.post(this.slackWebhookUrl, payload);
            console.info(`Alert sent: ${message.split('\n')[0]}`);
        } catch (error) {
            console.error(`Failed to send Slack message: ${error.message}`);
            throw error;
        }
    }

    async sendSlackUpdates(results) {
        try {
            const now = Date.now();
            
            results.forEach(result => {
                const problematicApps = result.applications
                    .filter(app => !app.name.includes('argocd-apps'))
                    .filter(app => 
                        app.healthStatus === 'Unknown' || 
                        app.healthStatus === 'Degraded' ||
                        app.healthStatus === 'Missing' ||
                        app.syncStatus === 'OutOfSync'
                    );

                if (problematicApps.length > 0) {
                    console.log(`[${result.name}] Problematic Applications:
                        ${problematicApps.map(app => `- ${app.name}: ${app.healthStatus === 'Healthy' ? '' : app.healthStatus}${app.syncStatus !== 'Synced' ? `${app.healthStatus === 'Healthy' ? '' : '/'}${app.syncStatus}` : ''}`).join('\n')}
                    `);
                }
            });

            for (const result of results) {
                const problematicApps = result.applications
                    .filter(app => !app.name.includes('argocd-apps'))
                    .filter(app => 
                        app.healthStatus === 'Unknown' || 
                        app.healthStatus === 'Degraded' ||
                        app.healthStatus === 'Missing' ||
                        app.syncStatus === 'OutOfSync'
                    );

                const lastAlert = this.lastAlerts.get(result.name);
                const shouldSendAlert = !lastAlert || (now - lastAlert > this.alertInterval);

                if (problematicApps.length > 0 && shouldSendAlert) {
                    const message = this.formatAlert(result.name, problematicApps, result.url);
                    await this.sendSlackMessage(message, result.url);
                    this.lastAlerts.set(result.name, now);
                    console.log(`[${result.name}] Alert sent for ${problematicApps.length} problematic apps`);
                } else if (problematicApps.length > 0) {
                    console.log(`[${result.name}] Alert skipped - Less than 24 hours since last alert`);
                } else if (this.lastAlerts.has(result.name)) {
                    const recoveryMessage = `:argo: *${result.name}* :argo:\nAll issues have been resolved.`;
                    await this.sendSlackMessage(recoveryMessage);
                    this.lastAlerts.delete(result.name);
                    console.log(`[${result.name}] Recovery alert sent`);
                }
            }
        } catch (error) {
            console.error('Slack update error:', error);
            throw error;
        }
    }

    formatAlert(clusterName, apps, clusterUrl) {
        const lines = [
            `:argo: *${clusterName}* :argo:\n`,
            `Applications requiring attention:`
        ];

        const groupedApps = {
            Missing: apps.filter(app => app.healthStatus === 'Missing'),
            Unknown: apps.filter(app => app.healthStatus === 'Unknown'),
            Degraded: apps.filter(app => app.healthStatus === 'Degraded'),
            OutOfSync: apps.filter(app => app.syncStatus === 'OutOfSync' && app.healthStatus === 'Healthy')
        };

        Object.entries(groupedApps).forEach(([status, statusApps]) => {
            if (statusApps.length > 0) {
                lines.push(`\n*${status}:*`);
                statusApps.forEach(app => {
                    const appUrl = `${clusterUrl}/applications/${app.name}`;
                    const statusText = status === 'OutOfSync' ? 'OutOfSync' : app.healthStatus;
                    lines.push(`• <${appUrl}|${app.name}>: ${statusText}`);
                });
            }
        });

        return lines.join('\n');
    }

    calculateMetrics(results) {
        const metrics = this.getEmptyMetrics();

        results.forEach(result => {
            if (result.applications) {
                metrics.totalApps += result.applications.length;

                result.applications.forEach(app => {
                    if (app.healthStatus === 'Healthy') metrics.healthyApps++;
                    if (app.healthStatus === 'Degraded') metrics.degradedApps++;
                    if (app.healthStatus === 'Failed') metrics.failedApps++;
                    if (app.healthStatus === 'Unknown') metrics.unknownApps++;
                    if (app.syncStatus === 'Synced') metrics.syncedApps++;
                    if (app.syncStatus === 'OutOfSync') metrics.outOfSyncApps++;
                    if (app.syncStatus === 'Processing') metrics.processingApps++;
                });
            }
        });

        return metrics;
    }

    getUpdateStatus() {
        const state = this.getGlobalState();
        const now = new Date();
        const lastUpdateTime = state.lastUpdate ? new Date(state.lastUpdate) : null;
        const nextUpdate = lastUpdateTime ?
            new Date(lastUpdateTime.getTime() + this.updateInterval) :
            new Date(now.getTime() + this.updateInterval);

        return {
            lastUpdate: state.lastUpdate,
            nextUpdate: nextUpdate.toISOString(),
            remainingSeconds: Math.max(0, Math.floor((nextUpdate - now) / 1000)),
            isUpdating: this.isUpdating
        };
    }

    async forceRefresh() {
        if (this.isUpdating) {
            throw new Error('Update already in progress');
        }
        await this.refreshData();
        return this.getGlobalState();
    }
}

module.exports = {
    ArgoVisor,
    ArgoCDCluster
};