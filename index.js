const http = require("http");
const express = require("express");
const Docker = require("dockerode");
const httpProxy = require("http-proxy");
// Fix: Correct Docker socket path
const docker = new Docker({socketPath: "/var/run/docker.sock"});
const proxy = httpProxy.createProxy({});

// Using in-memory database to hashmap
const db = new Map();

docker.getEvents(function(err, stream) {
    if(err){
        console.log(err);
        return;
    }
    stream.on('data', async(chunk) => {
        if(!chunk) return;
        const event = JSON.parse(chunk.toString());
        if(event.Type === 'container' && event.Action === 'start'){
            const container = docker.getContainer(event.id);
            const containerInfo = await container.inspect();
            const containerName = containerInfo.Name.substring(1);
            const containerIPv4 = containerInfo.NetworkSettings.IPAddress;
            const exposedPorts = Object.keys(containerInfo.Config.ExposedPorts || {});
            let defaultPort = null;
            
            if(exposedPorts && exposedPorts.length > 0){
                const [port, type] = exposedPorts[0].split('/');
                if(type === 'tcp'){
                    defaultPort = port;
                }
            }
            console.log(`Registering ${containerName}.localhost --> http://${containerIPv4}:${defaultPort}`);
            db.set(containerName, {containerName, containerIPv4, defaultPort});
        }
    });
});

// REVERSE_PROXY
const reverse_proxy_app = express();
reverse_proxy_app.use(express.json()); // Add this line for parsing JSON bodies

reverse_proxy_app.use(function(req, res){
    const hostname = req.hostname;
    const subdomain = hostname.split('.')[0];
    if(!db.has(subdomain)) return res.status(404).send('Not Found');
    const {containerIPv4, defaultPort} = db.get(subdomain);
    const target = `http://${containerIPv4}:${defaultPort}`;
    console.log(`Forwarding ${hostname} -> ${target}`);
    return proxy.web(req, res, {target, changeOrigin: true});
});

const reverse_proxy = http.createServer(reverse_proxy_app);

// MANAGEMENT API
const managementAPI = express();
managementAPI.use(express.json()); // Add this line for parsing JSON bodies

managementAPI.post('/containers', async(req, res) => {
    try {
        const {image, tag = "latest"} = req.body;
        const images = await docker.listImages();
        let alreadyImageExists = false;

        for(const systemImage of images){
            if (systemImage.RepoTags) {  // Add null check
                for(const systemTag of systemImage.RepoTags){
                    if(systemTag === `${image}:${tag}`){
                        alreadyImageExists = true;
                        break;
                    }
                }
            }
            if(alreadyImageExists) break;
        }

        if(!alreadyImageExists){
            console.log(`Pulling image: ${image}:${tag}`);
            await docker.pull(`${image}:${tag}`);
        }

        // Fix: Correct method name from createContianer to createContainer
        const container = await docker.createContainer({
            Image: `${image}:${tag}`,
            Tty: false,
            // detached mode
            HostConfig: {
                AutoRemove: true,
            }
        });

        await container.start();
        // Fix: Change response to res
        return res.json({
            status: 'success',
            container: `${(await container.inspect()).Name.substring(1)}.localhost`,
        });
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

managementAPI.listen(8080, () => {
    console.log("Management API is listening on port: 8080");
});

reverse_proxy.listen(80, () => {
    console.log("Reverse Proxy is running on port: 80");
});