import { io, type Socket } from 'socket.io-client';
export const connect = (): Socket => io({ reconnectionDelay: 300, reconnectionDelayMax: 2000 });
