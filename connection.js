/*
 * Copyright (c) 2020. Christopher Queen Consulting LLC (http://www.ChristopherQueenConsulting.com/)
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

class Connection extends EventEmitter {
    constructor({key, secret, domain = 'www.deribit.com', debug = false}) {
        super();

        this.reconnectingCount = 0;
        this.DEBUG = debug;
        this.heartBeat = 60 * 1; //1 minutes in seconds
        //this.heartBeat = 10; //1 minutes in seconds

        this.key = key;
        this.secret = secret;
        this.WSdomain = domain;

        //this.log(`Key: ${key} | Secret: ${secret} | Domain: ${domain} | Debug: ${debug}`);

        this.connected = false;
        this.isReadyHook = false;
        this.isReady = new Promise((r => this.isReadyHook = r));
        this.authenticated = false;
        this.reconnecting = false;
        this.afterReconnect = false;

        this.inflightQueue = [];
        this.subscriptions = [];

        this.id = +new Date;
    }

    log(message, variable = false) {
        if (variable !== false) {
            message = message + JSON.stringify(variable);
        }
        if (this.DEBUG) {
            console.log(message);
        }
    }

    nextId() {
        return ++this.id;
    }

    handleError(e) {
        if (this.DEBUG) {
            this.log(new Date, `Handle ERROR: ${JSON.stringify(e)}`);
        }
        throw new Error(e);
    }

    handleOnOpen(){
        this.connected = true;
        this.pingInterval = setInterval(this.ping.bind(this), (this.heartBeat * 1000) * 5); // 5X the heart beat without a ping means connection is dead
        this.isReadyHook();
    }

    _connect() {
        if (this.connected) {
            return;
        }

        let promise = new Promise((resolve, reject) => {
            this.ws = new WebSocket(`wss://${this.WSdomain}/ws/api/v2`);
            this.ws.onmessage =  (message) => {
               return this.handleWSMessage(message);
            }

            this.ws.onopen = () => {
                this.handleOnOpen();
                resolve();
            }


            //this.ws.onerror = this.handleError;
            //this.ws.on('error', this.handleError);
            this.ws.onerror = (error) => {
                this.handleError(error);
            }


            this.ws.onclose = async () => {
                if (this.DEBUG)
                    this.log(new Date + '-> CLOSED CON');

                this.inflightQueue.forEach((queueElement) => {
                    //queueElement.connectionAborted();
                    queueElement.connectionAborted(new Error('Deribit Connection Closed'));
                    //queueElement.connectionAborted('Deribit Connection Closed');

                });


                //throw(new Error("Deribit Connection Closed. We will reconnect when we catch this error"));
                this.inflightQueue = [];
                this.authenticated = false;
                this.connected = false;
                clearInterval(this.pingInterval);
                if (this.reconnectingCount < 3) {
                    this.reconnect();
                } else {
                    this.log(`Cannot properly reconnect to Deribit. Exiting Node and restarting Docker container.`);
                    this.end();
                    reject();
                    process.exit(1);
                }


            }
        });

        promise.catch((error) => {

            this.log("Error:");
            this.log(error.message);
            this.log(error.stack);

            this.inflightQueue = [];
            this.authenticated = false;
            this.connected = false;
            clearInterval(this.pingInterval);
            return this.reconnect();
        });

        return promise;
    }

    async ping() {
        let start = new Date;

        const timeout = setTimeout(() => {
            if (this.DEBUG)
                this.log(new Date, ' NO PING RESPONSE');
            this.terminate();
        }, (this.heartBeat * 1000)); // If 5X the Heartbeat goes by then we will terminate the connection because it is dead

        await this.request('public/test');
        clearInterval(timeout);
    }

    // terminate a connection and immediatly try to reconnect
    async terminate() {
        if (this.DEBUG)
            this.log(new Date, ' TERMINATED WS CON');
        this.ws.terminate();
        this.authenticated = false;
        this.connected = false;
    }

    // end a connection
    async end() {
        if (this.DEBUG)
            this.log(new Date, ' ENDED WS CON');
        this.subscriptions.forEach(sub => {
            this.unsubscribe(sub.type, sub.channel);
        });
        clearInterval(this.pingInterval);
        this.ws.onclose = undefined;
        this.request('private/logout', {access_token: this.token});
        this.authenticated = false;
        this.connected = false;
        this.ws.terminate();
    }

    wait(n) {
        return new Promise(r => setTimeout(r, n))
    };


    async reconnect() {
        this.reconnecting = true;
        this.reconnectingCount++;

        let hook;
        this.afterReconnect = new Promise(r => hook = r);
        this.isReady = new Promise((r => this.isReadyHook = r));
        await this.wait(5000);
        if (this.DEBUG)
            this.log(new Date, ' RECONNECTING...');
        let p = await this.connect();
        hook();
        this.isReadyHook();

        this.subscriptions.forEach(sub => {
            this.subscribe(sub.type, sub.channel);
        });

        return p;
    }

    async connect() {
        await this._connect();
        if (this.key) {
            await this.authenticate();
        }
        // Set the heartbeat (in seconds)
        await this.request("public/set_heartbeat", {interval: this.heartBeat});
        //.then(async () => {
        //this.on('test_request', this.handleWSMessage);
        //});

    }

    async authenticate() {
        if (!this.connected) {
            await this.connect();
        }

        let today = new Date();
        let date = today.getFullYear() + '_' + (today.getMonth() + 1) + '_' + today.getDate();

        const resp = await this.sendMessage({
            'jsonrpc': '2.0',
            'method': 'public/auth',
            'id': this.nextId(),
            'params': {
                'grant_type': 'client_credentials',
                'client_id': this.key,
                'client_secret': this.secret,
                'scope': 'session:tradingapp_docker_nodejs' + date
            }
        });

        if (resp.error) {
            throw new Error(resp.error.message);
        }

        this.token = resp.result.access_token;
        this.refreshToken = resp.result.refresh_token;
        this.authenticated = true;

        if (!resp.result.expires_in) {
            throw new Error('Deribit did not provide expiry details');
        }

        /*
        wait(resp.result.expires_in - 10 * 60 * 1000).then(() => this.refreshTokenFn()).catch(error => {
            this.log(`Error while refreshing token: ${error.message}`)
        })

         */

        let refreshTime = (resp.result.expires_in - (10 * 60)) * 1000; // (ExpireTime (seconds) - 10 Minutes (in seconds)) converted back to Milliseconds
        //let today = Date.now();
        let expireDateMilli = today + refreshTime;
        let expireDate = new Date(expireDateMilli);
        this.log(`Refresh Token Expires On: ${expireDate.toString()}`);
        let safeRefresh = Math.min(refreshTime, (Math.pow(2, 31) - 1));
        setTimeout(this.refreshTokenFn.bind(this), safeRefresh);
        //setTimeout(this.refreshTokenFn, resp.result.expires_in - 10 * 60 * 1000);
    }

    async refreshTokenFn() {
        this.log(`Refreshing Token Now.`);
        const resp = await this.sendMessage({
            'jsonrpc': '2.0',
            'method': 'public/auth',
            'id': this.nextId(),
            'params': {
                'grant_type': 'refresh_token',
                'refresh_token': this.refreshToken
            }
        });

        this.token = resp.result.access_token;
        this.refreshToken = resp.result.refresh_token;

        if (!resp.result.expires_in) {
            throw new Error('Deribit did not provide expiry details');
        }

        /*
        wait(resp.result.expires_in - 10 * 60 * 1000).then(() => this.refreshTokenFn()).catch(error => {
            this.log(`Error while refreshing token: ${error.message}`)
        })
         */

        let refreshTime = (resp.result.expires_in - (10 * 60)) * 1000; // (ExpireTime (seconds) - 10 Minutes (in seconds)) converted back to Milliseconds
        let today = Date.now();
        let expireDateMilli = today + refreshTime;
        let expireDate = new Date(expireDateMilli);
        this.log(`Refresh Token Expires On: ${expireDate.toString()}`);
        let safeRefresh = Math.min(refreshTime, (Math.pow(2, 31) - 1));
        setTimeout(this.refreshTokenFn.bind(this), safeRefresh);
    }

    findRequest(id) {
        let foundReq = false;
        for (let i = 0; i < this.inflightQueue.length; i++) {
            let req = this.inflightQueue[i];
            if (id === req.id) {
                this.inflightQueue.splice(i, 1);
                foundReq = req;
                break;
            }
        }
        return foundReq;
    }

    async handleWSMessage(e) {
        let payload;

        try {
            payload = JSON.parse(e.data);
        } catch (e) {
            console.error('deribit sent bad json', e);
        }

        if (payload.method === 'subscription') {
            clearInterval(this.pingInterval);
            return this.emit(payload.params.channel, payload.params.data);
        }

        if (payload.method === 'heartbeat' || payload.method === 'test_request' || payload.method === 'ping') {
            if (this.DEBUG) {
                this.log(new Date + ' -> Responding to Heartbeat Request')
            }
            clearInterval(this.pingInterval);
            return this.sendMessage({
                'jsonrpc': '2.0',
                'method': 'public/test',
                'id': this.nextId(),
                'param': {}
            })
        }

        let request = this.findRequest(payload.id);

        if (!request) {
            return console.error('received response to request not send:', payload);
        }

        payload.requestedAt = request.requestedAt;
        payload.receivedAt = +new Date;
        request.onDone(payload);
    }

    async sendMessage(payload, fireAndForget) {
        if (!this.connected) {
            if (!this.reconnecting) {
                throw new Error('Not connected.')
            }

            await this.afterReconnect;
        }

        let p;
        if (!fireAndForget) {
            let onDone;
            let connectionAborted;
            p = new Promise((r, rj) => {
                onDone = r;
                connectionAborted = rj;

                this.inflightQueue.push({
                    requestedAt: +new Date,
                    id: payload.id,
                    onDone,
                    connectionAborted
                });

            });


        }

        this.ws.send(JSON.stringify(payload));

        /*
        .catch((e) => {
            const reason = new Error(`failed sending message: ${JSON.stringify(payload)}`);
            reason.stack += `\nCaused By:\n` + e.stack;
            return reason;
        });

         */
        /*
       // CDQ - added retry for message that may fail
      try {
           this.ws.send(JSON.stringify(payload));

    } catch (error) {
           this.log(error);
           await this.reconnect();
           setTimeout(() => {
               this.sendMessage(payload, fireAndForget)
           }, 5 * 1000);
       }
    */
        //clearInterval(this.pingInterval);
        return p;
    }


    async request(path, params) {

        if (!this.connected) {
            if (!this.reconnecting) {
                throw new Error('Not connected.');
            }

            await this.afterReconnect;
        }

        if (path.startsWith('private')) {
            if (!this.authenticated) {
                throw new Error('Not authenticated.');
            }
        }

        const message = {
            'jsonrpc': '2.0',
            'method': path,
            'params': params,
            'id': this.nextId()
        };

        //this.log(`Sending Message: `, message);
        return this.sendMessage(message);
    }

    unsubscribe(type, channel) {

        if (!this.connected) {
            throw new Error('Not connected.');
        } else if (type === 'private' && !this.authenticated) {
            throw new Error('Not authenticated.');
        }

        const message = {
            'jsonrpc': '2.0',
            'method': `${type}/unsubscribe`,
            'params': {
                'channels': [channel]
            },
            'id': this.nextId()
        };

        return this.sendMessage(message);
    }


    subscribe(type, channel) {

        this.subscriptions.push({type, channel});

        if (!this.connected) {
            throw new Error('Not connected.');
        } else if (type === 'private' && !this.authenticated) {
            throw new Error('Not authenticated.');
        }

        const message = {
            'jsonrpc': '2.0',
            'method': `${type}/subscribe`,
            'params': {
                'channels': [channel]
            },
            'id': this.nextId()
        };

        return this.sendMessage(message);
    }

    async cancel_order_by_label(label) {
        return await this.request(`private/cancel_by_label`,
            {
                'label': label
            })
            .catch((e) => {
                this.log(`Could not return after cancel_order_by_label() Error : `, e.message);
                //throw new Error(`Could not return after cancel_order_by_label()`);
            });
    }

    async close_position(instrument, type) {
        return await this.request(`private/close_position`,
            {
                'instrument_name': instrument,
                'type': type
            })
            .catch((e) => {
                this.log(`Could not return after close_position() Error: `, e.message);
                throw new Error(`Could not return after close_position()`);
            });
    }

    async getPosition(instrument) {
        return await this.request(`private/get_position`,
            {
                'instrument_name': instrument
            })
            .catch((e) => {
                this.log(`Could not return after getPosition() : `, e.message);
                throw new Error(`Could not return after getPosition()`);
            });
    }

    async get_tradingview_chart_data(instrument, start, end, resolution) {
        return await this.request('public/get_tradingview_chart_data', {
            'instrument_name': instrument,
            'start_timestamp': start,
            'end_timestamp': end,
            'resolution': resolution
        })
            .catch((e) => {
                this.log(`Could not return after get_tradingview_chart_data() Error: `, e.message)
                throw new Error(`Could not return after get_tradingview_chart_data()`);
            });
    }

    async buy(options) {
        return await this.request('private/buy', options)
            .catch((e) => {
                this.log(`Could not return after buy() Error: `, e.message);
                throw new Error(`Could not return after buy()`);
            });
    }

    async sell(options) {
        return await this.request('private/sell', options)
            .catch((e) => {
                this.log(`Could not return after sell() Error: `, e.message);
                throw new Error(`Could not return after sell()`);
            });
        ;
    }

    async get_open_orders_by_instrument(instrument, type = "all") {
        return await this.request('private/get_open_orders_by_instrument', {
            'instrument_name': instrument,
            'type': type
        })
            .catch((e) => {
                this.log(`Could not return after get_open_orders_by_instrument() Error: `, e.message);
                throw new Error(`Could not return after get_open_orders_by_instrument()`);
            });
    }

    async get_stop_order_history(instrument, currency = "BTC", count = 30) {
        return await this.request('private/get_stop_order_history', {
            'instrument_name': instrument,
            'currency': currency,
            'count': count
        })
            .catch(e => {
                this.log(`Could not return after get_stop_order_history() Error: `, e.message);
                throw new Error(`Could not return after get_stop_order_history()`);
            });
    }

    async editOrder(orderId, orderSizeUSD, price = false, stopPrice = false) {
        let orderEditOptions = {
            "order_id": orderId,
            "amount": orderSizeUSD,
        };
        if (price) {
            orderEditOptions['price'] = price;
        }
        if (stopPrice) {
            orderEditOptions['stop_price'] = stopPrice;
        }
        return await this.request(`private/edit`, orderEditOptions)
            .catch((e) => {
                this.log(`Could not return after editOrder() : `, e.message);
                throw new Error(`Could not return after editOrder()`);
            });
    }

    async enable_cancel_on_disconnect() {
        return await this.request('private/enable_cancel_on_disconnect')
            .catch((e) => {
                this.log(`Could not return after enable_cancel_on_disconnect() Error: `, e.message);
                throw new Error(`Could not return after enable_cancel_on_disconnect()`);
            });
    }

    async disable_cancel_on_disconnect() {
        return await this.request('private/disable_cancel_on_disconnect')
            .catch((e) => {
                this.log(`Could not return after disable_cancel_on_disconnect() Error: `, e.message);
                throw new Error(`Could not return after disable_cancel_on_disconnect()`);
            });
    }

    async get_account_summary(currency, extended) {
        return await this.request('private/get_account_summary',
            {
                'currency': currency,
                'extended': extended
            }).catch((e) => {
            this.log(`Could not return after get_account_summary() Error: `, e.message);
            throw new Error(`Could not return after get_account_summary()`);
        });
    }

    async get_instruments(currency, kind, expired) {
        return await this.request('public/get_instruments',
            {
                'currency': currency,
                'kind': kind,
                'expired': expired
            }).catch((e) => {
            this.log(`Could not return after get_instruments() Error: `, e.message);
            throw new Error(`Could not return after get_instruments()`);
        });
    }

    async get_book_summary_by_instrument(instrument) {
        return await this.request('public/get_book_summary_by_instrument',
            {
                'instrument_name': instrument
            }).catch((e) => {
            this.log(`Could not return after get_book_summary_by_instrument() Error: `, e.message);
            throw new Error(`Could not return after get_book_summary_by_instrument()`);
        });
    }

    async get_ticker(instrument) {
        return await this.request('public/ticker',
            {
                'instrument_name': instrument
            }).catch((e) => {
            this.log(`Could not return after get_ticker() Error: `, e.message);
            throw new Error(`Could not return after get_ticker()`);
        });
    }

}
module.exports = Connection;