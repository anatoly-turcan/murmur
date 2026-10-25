import { http, type RequestOf } from '@murmur/node/capabilities';

const web = http();

export default web;

export type WebRequest = RequestOf<typeof web>;
