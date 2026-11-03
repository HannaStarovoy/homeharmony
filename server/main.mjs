import { createApp } from './app.mjs';
const port=Number(process.env.PORT||8000),host=process.env.HOST||'127.0.0.1';
if (!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid PORT');
const {server,store}=createApp();
server.listen(port,host,()=>console.log(`Store listening on ${host}:${port}; admin: /admin`));
const expiryTimer=setInterval(()=>{try{store.orders.expire()}catch(error){console.error('Reservation expiry failed:',error.code||error.name)}},60000);expiryTimer.unref();
function shutdown(){clearInterval(expiryTimer);server.close(()=>{store.close();process.exit(0)})}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
