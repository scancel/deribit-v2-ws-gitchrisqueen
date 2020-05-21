/*
 * Copyright (c) 2020. Christopher Queen Consulting LLC (http://www.ChristopherQueenConsulting.com/)
 */

const connection = require('../connection');
const key = '3hjn18oV';
const secret = '7Cc7CuVeN3QibJtRHA-w_GAzMnqWm-8PddsicaS3vlw';
const domain = 'test.deribit.com';
const debug = false;
const con = new connection({key,secret,domain,debug});

jest.setTimeout(10000); // 10 seconds

beforeAll(  () => {
    return con.connect();
});

afterAll(  () => {
    return con.end();
});

test('connect() expects properties[ connection:true,token,refreshToken,authenticated:true] and to be undefined', async () => {
    expect(con).toHaveProperty('connected',true);
    expect(con).toHaveProperty('token');
    expect(con).toHaveProperty('refreshToken');
    expect(con).toHaveProperty('authenticated',true);
});

