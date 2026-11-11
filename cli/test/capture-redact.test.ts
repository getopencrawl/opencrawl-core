import {test,expect} from 'bun:test';
import {redactText,redactValue,redactAttachment,SECRET_MASK} from '../src/capture/redact.ts';

// Synthetic format fixtures, never working credentials.
const keyMarker=(side:string)=>'-----'+side+' '+['RSA','PRIVATE','KEY'].join(' ')+'-----';
const jwtPart=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const samples=[
  'ghp_'+'A'.repeat(36), 'github_pat_'+'b'.repeat(82), 'glpat-'+'c'.repeat(20),
  'AKIA'+'A'.repeat(16), 'ASIA'+'B'.repeat(16), 'AIza'+'d'.repeat(35),
  'ya29.'+'e'.repeat(50), 'sk-ant-api03-'+'f'.repeat(93)+'AA',
  'sk-proj-'+'g'.repeat(140), 'sk-'+'a'.repeat(20)+'T3BlbkFJ'+'b'.repeat(20),
  'sk_live_'+'h'.repeat(24), 'rk_test_'+'i'.repeat(30),
  'xoxb-'+'1'.repeat(12)+'-'+'2'.repeat(12)+'-'+'j'.repeat(24),
  'xapp-1-'+'k'.repeat(40), 'https://hooks.slack.com/services/T12345678/B12345678/'+'l'.repeat(24),
  'npm_'+'m'.repeat(36), 'pypi-AgEIcHlwaS5vcmc'+'n'.repeat(60),
  'SG.'+'o'.repeat(22)+'.'+'p'.repeat(43), 'key-'+'a'.repeat(32),
  'hvs.'+'q'.repeat(30), 'dop_v1_'+'b'.repeat(64), 'hf_'+'r'.repeat(34),
  jwtPart({alg:'HS256'})+'.'+jwtPart({sub:'fixture'})+'.'+'s'.repeat(43),
  keyMarker('BEGIN')+'\n'+'fixture'.repeat(20)+'\n'+keyMarker('END'),
];
for(const [index,value] of samples.entries())test('credential format '+index+' is masked deterministically',()=>{
  expect(redactText('before '+value+' after')).toBe('before '+SECRET_MASK+' after');
  expect(redactText(redactText(value))).toBe(SECRET_MASK);
});

test('ordinary identifiers, hashes, public keys, code, URLs and variable references survive',()=>{
  const benign=[
    '01a1c94f-33c1-7723-a284-30f5198f0497', '550e8400-e29b-41d4-a716-446655440000',
    'a'.repeat(40), 'b'.repeat(64), 'session_01M6N70ZNZHJ38FZ7E77KBT4TH',
    'pk_live_'+'q'.repeat(24), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfixture user@host',
    'https://example.com/items/550e8400-e29b-41d4-a716-446655440000?cursor=abc123def456',
    'const token_count=32000; const key="abcdefghijklm"; const sessionId="1234567890";',
    'API_KEY=$MY_KEY', 'password=${PASSWORD}', 'access_token=process.env.TOKEN',
    'api_key: <your-key>', 'password: [REDACTED]', 'token: true',
  ];
  for(const value of benign)expect(redactText(value)).toBe(value);
  const ids={sessionId:benign[0],trace_id:benign[1],sha256:benign[3],token_count:32000,api_key:'${API_KEY}'};
  expect(redactValue(ids)).toEqual(ids);
});

test('credential context masks opaque values but preserves surrounding structure',()=>{
  for(const name of ['api_key','apiKey','OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','client_secret','password','accessToken']) {
    expect(redactText(name+'="hunter22"')).toBe(name+'="[REDACTED]"');
    expect(redactValue({[name]:'550e8400-e29b-41d4-a716-446655440000'})).toEqual({[name]:SECRET_MASK});
  }
  expect(redactText('Authorization: Bearer opaque-token-123')).toBe('Authorization: Bearer [REDACTED]');
  expect(redactText('password="a long password with spaces" tail')).toBe('password="[REDACTED]" tail');
  expect(redactText("password='hunter2' tail")).toBe("password='[REDACTED]' tail");
  expect(redactText('https://user:password123@host/db?api_key=opaque-token-123&limit=10')).toBe('https://user:[REDACTED]@host/db?api_key=[REDACTED]&limit=10');
  const nested={arguments:JSON.stringify({headers:{Authorization:'Bearer opaque-token-123'},password:'escaped\u0021secret',traceId:'550e8400-e29b-41d4-a716-446655440000'})};
  const masked=redactValue(nested);
  expect(JSON.parse(masked.arguments)).toEqual({headers:{Authorization:SECRET_MASK},password:SECRET_MASK,traceId:'550e8400-e29b-41d4-a716-446655440000'});
  expect(redactValue(masked)).toEqual(masked);expect(nested.arguments).toContain('escaped');
  expect(redactValue({[samples[0]!]:samples[1]})).toEqual({[SECRET_MASK]:SECRET_MASK});
});

test('private key tails are withheld; decoded text and binary attachment bytes are covered',()=>{
  expect(redactText('before '+keyMarker('BEGIN')+'\nunfinished secret')).toBe('before '+SECRET_MASK);
  expect(redactAttachment(Buffer.from('token='+samples[0]))?.toString()).toBe('token='+SECRET_MASK);
  expect(redactAttachment(Buffer.concat([Buffer.from([0,255]),Buffer.from(samples[0]!)]))).toBeNull();
  const binary=Buffer.from([0,255,1,2,3]);expect(redactAttachment(binary)).toEqual(binary);
});

test('oversized nesting fails closed and repeated near matches complete within the test deadline',()=>{
  let nested:any={token:samples[0]};for(let i=0;i<70;i++)nested={nested};
  expect(()=>redactValue(nested)).toThrow('masking depth');
  const text=('word'.repeat(40)+' uuid=550e8400-e29b-41d4-a716-446655440000\n').repeat(5000);
  expect(redactText(text)).toBe(text);
});
