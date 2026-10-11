import { Knowledge } from './knowledge';
import { Component, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { publicApiOrigin } from './chatbot-context';
interface Organization {id:string;name:string;role:string}
interface Usage {used:number;limit:number|null;remaining:number|null;percentage:number|null}
interface Key {id:string;name:string;key_prefix:string;scopes:string[];expires_at:string|null;revoked_at:string|null}
@Component({
  selector:'app-account', imports:[FormsModule,Knowledge],
  template: `
    <section aria-labelledby="account-title">
      <h2 id="account-title">Organization account</h2>
      <p role="status">{{ message() }}</p>
      @if (!signedIn()) {
        <form (ngSubmit)="login()">
          <label>Email <input name="email" type="email" autocomplete="username" [(ngModel)]="email" required maxlength="254"></label>
          <label>Password <input name="password" type="password" autocomplete="current-password" [(ngModel)]="password" required maxlength="256"></label>
          <button [disabled]="busy()">Sign in</button>
        </form>
      } @else {
        <button (click)="logout()" [disabled]="busy()">Sign out</button>
        <label>Organization <select [ngModel]="organizationId" (ngModelChange)="selectOrganization($event)" [disabled]="busy()">
          <option value="">Select organization</option>
          @for (org of organizations();track org.id) {<option [value]="org.id">{{org.name}}</option>}
        </select></label>
        @if (plan()) {
          <h3>{{plan()}} · {{status()}}</h3>
          <p>Usage period: {{period()}}</p>
          <p>Public and internal chats share the message allowance.</p>
          <dl>
          @for (item of usage();track item.name) {
            <dt>{{item.name}}</dt><dd>{{item.value.used}}@if(item.value.limit !== null){ / {{item.value.limit}} · {{item.value.remaining}} remaining
              <progress [value]="item.value.percentage" max="100" [attr.aria-label]="item.name"></progress>}
            </dd>
          }
          </dl>
          <button (click)="knowledgeOpen.set(!knowledgeOpen())">{{knowledgeOpen() ? 'Hide knowledge sources' : 'Manage knowledge sources'}}</button>
          @if(knowledgeOpen()){<app-knowledge [organizationId]="organizationId" [csrf]="csrf" [canManage]="canManage()" />}
          <h3>Installation checklist</h3>
          <ul>@for(step of onboarding();track step.name){<li>{{step.name}}: {{step.ready ? 'Ready' : 'Pending'}}</li>}</ul>
          @if (canManage()) {
            <h3>API keys</h3>
            @if (!apiAccess()) {<p>Your plan does not include API access. Existing keys can still be revoked.</p>}
            <form (ngSubmit)="createKey()">
              <label>Key name <input name="keyName" [(ngModel)]="keyName" required maxlength="80"></label>
              <label>Expires at (optional, local time) <input name="expires" type="datetime-local" [(ngModel)]="expiresAt"></label>
              <p>Permission: send chat messages.</p>
              <button [disabled]="busy() || !apiAccess()">Create API key</button>
            </form>
            @if (newSecret()) {
              <aside aria-label="New API key"><p>Save this key now. It is shown only once.</p><code>{{newSecret()}}</code>
                <button (click)="copyKey()">Copy new key</button><button (click)="newSecret.set('')">Dismiss</button></aside>
            }
            <ul>@for(key of keys();track key.id){
              <li>{{key.name}} · {{key.key_prefix}}… · {{keyStatus(key)}} · Expires: {{key.expires_at || 'Never'}}
                @if(!key.revoked_at){<button (click)="revoke(key.id)" [disabled]="busy()">Revoke</button>}
              </li>
            }</ul>
            <button (click)="keyPage(-1)" [disabled]="busy() || keyOffset === 0">Previous keys</button>
            <button (click)="keyPage(1)" [disabled]="busy() || keys().length < 50">Next keys</button>
          }
        }
      }
    </section>`,
  styles:[`section{max-width:850px;margin:2rem auto;padding:1.5rem;background:white;color:#172033;border-radius:12px}label{display:block;margin:1rem 0}input,select{display:block;padding:.5rem;width:min(100%,30rem)}button{margin:.4rem;padding:.5rem 1rem}progress{display:block;width:100%}dt{font-weight:600;margin-top:.7rem}dd{margin:0}code{overflow-wrap:anywhere}aside{padding:1rem;background:#eef4ff}li{margin:.5rem 0}`],
})
export class Account {
  private http = inject(HttpClient);
  csrf = '';
  knowledgeOpen=signal(false);
  email='';password='';organizationId='';keyName='';expiresAt='';keyOffset=0;
  signedIn=signal(false);busy=signal(false);message=signal('');organizations=signal<Organization[]>([]);
  plan=signal('');status=signal('');period=signal('');apiAccess=signal(false);canManage=signal(false);
  usage=signal<{name:string;value:Usage}[]>([]);onboarding=signal<{name:string;ready:boolean}[]>([]);
  keys=signal<Key[]>([]);newSecret=signal('');
  private request<T>(method:string,path:string,body?:unknown) {
    return firstValueFrom(this.http.request<T>(method,`${publicApiOrigin()}/api${path}`,{body,withCredentials:true,
      headers: this.csrf ? {'X-CSRF-Token':this.csrf} : {}}));
  }
  private async perform(work:()=>Promise<void>) {
    if(this.busy())return;
    this.busy.set(true);this.message.set('');
    try{await work();}catch(e){
      this.message.set(e instanceof HttpErrorResponse ? e.error?.error?.message || 'Request failed. Please try again.' : 'Request failed. Please try again.');
      if(e instanceof HttpErrorResponse && e.status===401)this.clearSession();
    }finally{this.busy.set(false);}
  }
  private clearSession(){this.csrf='';this.signedIn.set(false);this.newSecret.set('');this.plan.set('');this.keys.set([]);this.usage.set([]);this.onboarding.set([]);this.organizations.set([]);this.organizationId='';}
  login(){return this.perform(async()=>{
    try {const r=await this.request<{csrfToken:string}>('POST','/auth/login',{email:this.email,password:this.password});
      this.csrf=r.csrfToken;this.signedIn.set(true);
      this.organizations.set((await this.request<{organizations:Organization[]}>('GET','/account/organizations')).organizations);
    } finally {this.password='';}
  });}
  logout(){return this.perform(async()=>{await this.request('POST','/auth/logout');this.clearSession();});}
  selectOrganization(id:string){return this.perform(async()=>{
    this.knowledgeOpen.set(false);this.organizationId=id;this.newSecret.set('');this.plan.set('');this.keys.set([]);this.keyOffset=0;
    if(!id)return;
    const base=`/organizations/${id}`;
    const [s,u,e,o]=await Promise.all([
      this.request<{plan:{name:string};subscription:{status:string};period:{start:string;end:string}}>('GET',`${base}/subscription`),
      this.request<{usage:Record<string,Usage>}>('GET',`${base}/usage`),
      this.request<{apiAccess:boolean}>('GET',`${base}/entitlements`),this.request<Record<string,boolean>>('GET',`${base}/onboarding-status`),
    ]);
    this.plan.set(s.plan.name);this.status.set(s.subscription.status);this.period.set(`${s.period.start.slice(0,10)} – ${s.period.end.slice(0,10)}`);
    this.apiAccess.set(e.apiAccess);this.canManage.set(this.organizations().find(v=>v.id===id)?.role!=='member');
    const label=(v:string)=>v.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase());
    this.usage.set(Object.entries(u.usage).map(([name,value])=>({name:label(name),value})));
    this.onboarding.set(Object.entries(o).map(([name,ready])=>({name:label(name),ready})));
    if(this.canManage())await this.loadKeys();
  });}
  private async loadKeys(){this.keys.set((await this.request<{apiKeys:Key[]}>('GET',`/organizations/${this.organizationId}/api-keys?limit=50&offset=${this.keyOffset}`)).apiKeys);}
  createKey(){return this.perform(async()=>{
    this.newSecret.set('');
    const r=await this.request<{secret:string}>('POST',`/organizations/${this.organizationId}/api-keys`,{name:this.keyName,scopes:['chat:write'],expiresAt:this.expiresAt?new Date(this.expiresAt).toISOString():null});
    this.newSecret.set(r.secret);this.keyName='';this.keyOffset=0;await this.loadKeys();
  });}
  revoke(id:string){return this.perform(async()=>{await this.request('DELETE',`/organizations/${this.organizationId}/api-keys/${id}`);this.newSecret.set('');await this.loadKeys();});}
  keyPage(direction:number){return this.perform(async()=>{this.keyOffset=Math.max(0,this.keyOffset+direction*50);await this.loadKeys();});}
  keyStatus(key:Key){return key.revoked_at ? 'Revoked' : key.expires_at && new Date(key.expires_at)<=new Date() ? 'Expired' : 'Active';}
  async copyKey(){if(this.newSecret()){try{await navigator.clipboard.writeText(this.newSecret());this.message.set('Key copied.');}catch{this.message.set('Copy unavailable. Select and save the displayed key.');}}}
}
