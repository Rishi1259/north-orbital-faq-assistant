import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting,HttpTestingController} from '@angular/common/http/testing';
import {Account} from './account';
import {afterEach,beforeEach,it,expect} from 'vitest';
let http:HttpTestingController;
beforeEach(()=>{TestBed.configureTestingModule({imports:[Account],providers:[provideHttpClient(),provideHttpClientTesting()]});http=TestBed.inject(HttpTestingController);});
afterEach(()=>http.verify());
it('requires sign-in and clears passwords after authentication',async()=>{
  const component=TestBed.createComponent(Account).componentInstance;component.email='owner@example.test';component.password='test password';
  const promise=component.login();const req=http.expectOne(r=>r.url.endsWith('/api/auth/login'));
  expect(req.request.withCredentials).toBe(true);req.flush({csrfToken:'csrf'});await Promise.resolve();
  http.expectOne(r=>r.url.endsWith('/api/account/organizations')).flush({organizations:[]});await promise;
  expect(component.password).toBe('');expect(component.signedIn()).toBe(true);
});
it('never retrieves a raw key from the list and clears the creation secret on organization change',async()=>{
  const component=TestBed.createComponent(Account).componentInstance;component.newSecret.set('no_live_one-time');
  await component.selectOrganization('');expect(component.newSecret()).toBe('');expect(component.keys()).toEqual([]);
});
it('renders escaped account labels and accessible progress',()=>{
  const fixture=TestBed.createComponent(Account),component=fixture.componentInstance;
  component.signedIn.set(true);component.plan.set('<script>Growth</script>');component.status.set('active');
  component.usage.set([{name:'Messages',value:{used:10,limit:100,remaining:90,percentage:10}}]);fixture.detectChanges();
  expect(fixture.nativeElement.querySelector('script')).toBeNull();expect(fixture.nativeElement.querySelector('progress').getAttribute('aria-label')).toBe('Messages');
});
it('shows privacy-safe API errors and does not retain failed credentials',async()=>{
  const component=TestBed.createComponent(Account).componentInstance;component.password='wrong';
  const promise=component.login();http.expectOne(r=>r.url.endsWith('/api/auth/login')).flush({error:{message:'Invalid email or password.'}},{status:401,statusText:'Unauthorized'});await promise;
  expect(component.password).toBe('');expect(component.message()).toBe('Invalid email or password.');expect(component.signedIn()).toBe(false);
});

it('distinguishes expired credentials from active and revoked credentials',()=>{
  const component=TestBed.createComponent(Account).componentInstance;
  const key={id:'id',name:'CRM',key_prefix:'no_live_prefix',scopes:['chat:write'],expires_at:'2000-01-01T00:00:00Z',revoked_at:null};
  expect(component.keyStatus(key)).toBe('Expired');
  expect(component.keyStatus({...key,expires_at:null})).toBe('Active');
  expect(component.keyStatus({...key,revoked_at:'2000-01-01T00:00:00Z'})).toBe('Revoked');
});
