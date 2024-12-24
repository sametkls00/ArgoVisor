// config/clusters.js
const clusters = {
    "CLUSTER_1": {
        url: process.env.CLUSTER_1_URL,
        username: process.env.CLUSTER_1_USERNAME,
        password: process.env.CLUSTER_1_PASSWORD
    },
    "CLUSTER_2": {
        url: process.env.CLUSTER_2_URL,
        username: process.env.CLUSTER_2_USERNAME,
        password: process.env.CLUSTER_2_PASSWORD
    },
    "CLUSTER_TEST": {
        url: process.env.CLUSTER_TEST_URL,
        username: process.env.CLUSTER_TEST_USERNAME,
        password: process.env.CLUSTER_TEST_PASSWORD
    }
};

module.exports = clusters;