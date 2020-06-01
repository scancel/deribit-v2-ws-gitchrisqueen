/*
 * Copyright (c) 2020. Christopher Queen Consulting LLC (http://www.ChristopherQueenConsulting.com/)
 */

//'use strict'

const Connection = require('../connection');

let con;

jest.setTimeout(10000); // 10 seconds

beforeAll(async () => {

    const key = '3hjn18oV';
    const secret = '8q5CotqH3hZv-01-CM-X00kT2lNWdMbPcOfbx0xZ8b4';
    const domain = 'test.deribit.com';
    const debug = true;
    con = new Connection({key, secret, domain, debug});
    /*
    await con.connect().catch((error) => {
        console.log(`${new Date} | could not connect`, error.message);
    });
    return;

     */

});

afterAll(() => {
    //return con.end();
});

describe('constructor()', () => {

    test('expects property connected = true', () => {
        expect(con).toHaveProperty('connected', false);
    });

    test('expects property authenticated = false', () => {
        expect(con).toHaveProperty('authenticated', false);
    });

});

describe('connect()', () => {
    beforeAll(async () => {
        return await con.connect();
    });

    test('expects property connected = true', () => {
        expect(con).toHaveProperty('connected', true);
    });
    test('expects property token', () => {
        expect(con).toHaveProperty('token');
    });
    test('expects property refreshToken', () => {
        expect(con).toHaveProperty('refreshToken');
    });
    test('expects property authenticated = true', () => {
        expect(con).toHaveProperty('authenticated', true);
    });

});

