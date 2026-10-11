import {Component,Input,OnChanges,OnDestroy,SimpleChanges,ViewChild,ElementRef,inject,signal} from '@angular/core';
import {HttpClient,HttpErrorResponse} from '@angular/common/http';
import {FormsModule} from '@angular/forms';
import {DatePipe} from '@angular/common';
import {firstValueFrom,timeout} from 'rxjs';
import {publicApiOrigin} from './chatbot-context';
export interface Lead {id:string;chatbot_id:string;name:string|null;normalized_email:string|null;phone:string|null;company:string|null;source:string;visitor_message:string|null;status:string;created_at:string;consent_given:boolean;consent_version:number;consent_at:string|null}
export interface Handoff {name?:string|null;normalized_email?:string|null;phone?:string|null;id:string;lead_id:string;status:string;reason:string;assigned_user_id:string|null;revision:number;requested_at:string;acknowledged_at:string|null;resolved_at:string|null}
type Settings=Record<string,string|boolean|number>;
@Component({selector:'app-leads',imports:[FormsModule,DatePipe],template:`
<section aria-labelledby="lead-title" [attr.aria-busy]="busy()">
  <h3 id="lead-title">Leads and human follow-up</h3>
  <p>Review contact requests in this app. Email notifications and live agent chat are not available.</p>
  <p role="status" class="feedback">{{message() || (busy()?'Working…':'')}}</p>
  <label for="leads-bot">Chatbot</label><select id="leads-bot" [ngModel]="botId" (ngModelChange)="selectBot($event)" [disabled]="busy() || dirty()"><option value="">Select chatbot</option>@for(bot of bots();track bot.id){<option [value]="bot.id">{{bot.name}}</option>}</select>
  @if(botId){
    <button (click)="refresh()" [disabled]="busy() || dirty()">Refresh requests</button>
    @if(settings();as s){
      <details><summary>Contact form settings</summary>
      @if(canManage){
        <form novalidate (ngSubmit)="saveSettings()" (change)="dirty.set(true)">
          <fieldset [disabled]="busy()"><legend>Visitor contact form</legend>
          <label><input type="checkbox" name="enabled" [(ngModel)]="s['enabled']"> Enable contact form</label>
          <label><input type="checkbox" name="handoffEnabled" [(ngModel)]="s['handoffEnabled']" aria-describedby="settings-error"> Enable human follow-up requests</label>
          @for(field of textFields;track field.key){<label [for]="field.key">{{field.label}}</label><textarea [id]="field.key" [name]="field.key" [(ngModel)]="s[field.key]" [maxLength]="field.max" rows="3" aria-describedby="settings-error" [attr.aria-invalid]="settingsError()?'true':null"></textarea>}
          @for(field of fields;track field){<fieldset><legend>{{field}}</legend><label><input type="checkbox" [name]="'collect'+field" [(ngModel)]="s['collect'+field]" (ngModelChange)="collectionChanged(field,$event)"> Collect {{field.toLowerCase()}}</label><label><input type="checkbox" [name]="'require'+field" [(ngModel)]="s['require'+field]" [disabled]="!s['collect'+field]"> Require {{field.toLowerCase()}}</label></fieldset>}
          <label><input type="checkbox" name="consentRequired" [(ngModel)]="s['consentRequired']"> Require explicit consent</label>
          <label for="consentText">Consent text</label><textarea id="consentText" name="consentText" [(ngModel)]="s['consentText']" maxlength="1000" rows="4" aria-describedby="settings-error" [attr.aria-invalid]="settingsError()?'true':null"></textarea>
          <p id="settings-error" role="status">{{settingsError() || 'Human follow-up requires email or phone. Text is displayed as plain text.'}}</p>
          <button [disabled]="busy()">Save contact settings</button><button type="button" (click)="cancelSettings()" [disabled]="busy()">Cancel changes</button>
          </fieldset>
        </form>
      }@else{<p>Contact form: {{s['enabled']?'Enabled':'Disabled'}} · Human follow-up: {{s['handoffEnabled']?'Enabled':'Disabled'}}. An administrator can change these settings.</p>}
      </details>
    }
    <h4>Leads</h4>
    <label for="lead-filter">Lead status</label><select id="lead-filter" [(ngModel)]="leadFilter" (ngModelChange)="filterChanged(false)" [disabled]="busy()"><option value="">All statuses</option>@for(status of leadStatuses;track status){<option [value]="status">{{status}}</option>}</select>
    <ul class="sources">@for(lead of leads();track lead.id){<li><strong>{{lead.name || 'Contact request'}}</strong><p>{{lead.normalized_email || lead.phone || 'No contact supplied'}} · {{lead.status}} · {{lead.created_at | date:'medium'}} · {{lead.source}}</p><button (click)="viewLead(lead.id)" [disabled]="busy()">View lead details</button></li>}@empty{<li>No leads in this view.</li>}</ul>
    <p>Showing {{leads().length}} leads · Page {{leadOffset/25+1}}</p><button (click)="page(false,-1)" [disabled]="busy() || leadOffset===0">Previous leads</button><button (click)="page(false,1)" [disabled]="busy() || !moreLeads()">Next leads</button>
    @if(detail();as lead){<section aria-labelledby="lead-detail-title" tabindex="-1" #detailPanel><h4 id="lead-detail-title">Lead details</h4>
      <dl><dt>Name</dt><dd>{{lead.name || 'Not supplied'}}</dd><dt>Email</dt><dd>{{lead.normalized_email || 'Not supplied'}}</dd><dt>Phone</dt><dd>{{lead.phone || 'Not supplied'}}</dd><dt>Company</dt><dd>{{lead.company || 'Not supplied'}}</dd><dt>Message</dt><dd class="answer">{{lead.visitor_message || 'Not supplied'}}</dd><dt>Consent</dt><dd>{{lead.consent_given?'Given':'Not given'}} · Version {{lead.consent_version}} · {{lead.consent_at | date:'medium'}}</dd></dl>
      @if(canManage){<label for="lead-status">Status</label><select id="lead-status" [ngModel]="lead.status" (ngModelChange)="setStatus($event)" [disabled]="busy()">@for(status of leadStatuses;track status){<option [value]="status">{{status}}</option>}</select><button class="danger" (click)="askDelete()" [disabled]="busy()">Delete lead</button>}
      <button (click)="detail.set(null)" [disabled]="busy()">Close lead details</button></section>}
    <h4>Human follow-up queue</h4>
    <label for="handoff-filter">Handoff status</label><select id="handoff-filter" [(ngModel)]="handoffFilter" (ngModelChange)="filterChanged(true)" [disabled]="busy()"><option value="">All statuses</option>@for(status of handoffStatuses;track status){<option [value]="status">{{status}}</option>}</select>
    <ul class="sources">@for(h of handoffs();track h.id){<li><strong>{{h.name || 'Contact request'}} · {{h.status}}</strong><p>{{h.normalized_email || h.phone}}</p><p>Requested {{h.requested_at | date:'medium'}} · Assigned to {{memberLabel(h.assigned_user_id)}}</p><button (click)="viewHandoff(h.id)" [disabled]="busy()">View follow-up details</button></li>}@empty{<li>No handoff requests in this view.</li>}</ul>
    <p>Showing {{handoffs().length}} requests · Page {{handoffOffset/25+1}}</p><button (click)="page(true,-1)" [disabled]="busy() || handoffOffset===0">Previous handoffs</button><button (click)="page(true,1)" [disabled]="busy() || !moreHandoffs()">Next handoffs</button>
    @if(handoffDetail();as h){<section aria-labelledby="handoff-detail-title" tabindex="-1" #handoffPanel><h4 id="handoff-detail-title">Follow-up details</h4><p class="answer">{{h.reason}}</p>
      @if(handoffLead();as lead){<p>{{lead.name || 'Contact request'}} · {{lead.normalized_email || lead.phone}}</p><p>{{lead.phone}} {{lead.company}}</p>}
      <p>{{h.status}} · Acknowledged {{(h.acknowledged_at | date:'medium') || 'Not yet'}} · Resolved {{(h.resolved_at | date:'medium') || 'Not yet'}}</p>
      @if(canManage && h.status!=='resolved' && h.status!=='cancelled'){
        <label for="assignee">Assigned organization member</label><select id="assignee" [ngModel]="h.assigned_user_id || ''" (ngModelChange)="act('assign',$event || null)" [disabled]="busy()"><option value="">Unassigned</option>@for(m of members();track m.user_id){<option [value]="m.user_id">{{m.email}} · {{m.role}}</option>}</select>
        @if(moreMembers()){<button (click)="loadMoreMembers()" [disabled]="busy()">Load more members</button>}
        @if(h.status==='requested'){<button (click)="act('acknowledge')" [disabled]="busy()">Acknowledge</button>}
        @if(h.status==='acknowledged'){<button (click)="act('resolve')" [disabled]="busy()">Resolve</button>}
        <button (click)="act('cancel')" [disabled]="busy()">Cancel request</button>
      }
      <button (click)="handoffDetail.set(null);handoffLead.set(null)" [disabled]="busy()">Close follow-up details</button></section>}
  }
  <dialog #confirmation aria-labelledby="delete-lead-title" aria-describedby="delete-lead-description" (cancel)="cancelDelete()"><h4 id="delete-lead-title">Delete lead?</h4><p id="delete-lead-description">Permanently remove this lead and all linked human follow-up requests. Usage history and safe audit events remain.</p><button autofocus (click)="cancelDelete()" [disabled]="busy()">Cancel</button><button class="danger" (click)="deleteConfirmed()" [disabled]="busy()">Delete lead permanently</button></dialog>
</section>`,styleUrls:['./admin-workbench.scss'],styles:[`input[type=checkbox]{display:inline;width:auto}fieldset{margin:1rem 0;border:1px solid var(--admin-border)}summary{cursor:pointer;padding:1rem 0}section section{overflow-wrap:anywhere}`]})
export class Leads implements OnChanges,OnDestroy {
  @Input({required:true}) organizationId='';@Input() csrf='';@Input() canManage=false;
  @ViewChild('confirmation') confirmation?:ElementRef<HTMLDialogElement>;@ViewChild('detailPanel') detailPanel?:ElementRef<HTMLElement>;@ViewChild('handoffPanel') handoffPanel?:ElementRef<HTMLElement>;
  private http=inject(HttpClient);private epoch=0;private saved:Settings|null=null;
  bots=signal<{id:string;name:string}[]>([]);settings=signal<Settings|null>(null);leads=signal<Lead[]>([]);handoffs=signal<Handoff[]>([]);
  members=signal<{user_id:string;email:string;role:string}[]>([]);moreMembers=signal(false);moreLeads=signal(false);moreHandoffs=signal(false);
  detail=signal<Lead|null>(null);handoffDetail=signal<Handoff|null>(null);handoffLead=signal<Lead|null>(null);
  busy=signal(false);message=signal('');settingsError=signal('');dirty=signal(false);
  botId='';leadOffset=0;handoffOffset=0;leadFilter='';handoffFilter='';
  fields=['Name','Email','Phone','Company','Message'];leadStatuses=['new','contacted','qualified','closed'];handoffStatuses=['requested','acknowledged','resolved','cancelled'];
  textFields=[{key:'formTitle',label:'Form title',max:120},{key:'formMessage',label:'Form message',max:1000},{key:'successMessage',label:'Success message',max:500}];
  ngOnChanges(changes:SimpleChanges){if(!changes['organizationId'])return;this.epoch++;this.botId='';this.reset();this.bots.set([]);this.busy.set(false);void this.perform(async token=>{const r=await this.request<{chatbots:{id:string;name:string}[]}>('GET',`/organizations/${this.organizationId}/chatbots`);if(token===this.epoch)this.bots.set(r.chatbots);});}
  ngOnDestroy(){this.epoch++;}
  private reset(){this.leads.set([]);this.handoffs.set([]);this.members.set([]);this.detail.set(null);this.handoffDetail.set(null);this.handoffLead.set(null);this.settings.set(null);this.dirty.set(false);this.saved=null;this.leadOffset=0;this.handoffOffset=0;this.leadFilter='';this.handoffFilter='';this.settingsError.set('');}
  private base(){return `/organizations/${this.organizationId}/chatbots/${this.botId}`;}
  private request<T>(method:string,path:string,body?:unknown){return firstValueFrom(this.http.request<T>(method,`${publicApiOrigin()}/api${path}`,{body,withCredentials:true,headers:{'X-CSRF-Token':this.csrf}}).pipe(timeout(30000)));}
  private async perform(work:(token:number)=>Promise<void>){if(this.busy())return;const token=this.epoch;this.busy.set(true);this.message.set('');try{await work(token);}catch(e){if(token===this.epoch)this.message.set(e instanceof HttpErrorResponse&&e.status===409?'This request changed. Close its details, refresh and reopen before trying again.':e instanceof HttpErrorResponse&&e.status===401?'Session expired. Sign in again.':'Request failed. Your changes are preserved. Check the form and try again.');}finally{if(token===this.epoch)this.busy.set(false);}}
  private async loadLists(token:number){const [l,h]=await Promise.all([this.request<{items:Lead[];hasMore:boolean}>('GET',`${this.base()}/leads?limit=25&offset=${this.leadOffset}${this.leadFilter?'&status='+this.leadFilter:''}`),this.request<{items:Handoff[];hasMore:boolean}>('GET',`${this.base()}/handoffs?limit=25&offset=${this.handoffOffset}${this.handoffFilter?'&status='+this.handoffFilter:''}`)]);if(token===this.epoch){this.leads.set(l.items);this.moreLeads.set(l.hasMore);this.handoffs.set(h.items);this.moreHandoffs.set(h.hasMore);}}
  refresh(){return this.perform(async token=>{const s=await this.request<Settings>('GET',`${this.base()}/lead-settings`);if(token!==this.epoch)return;this.saved={...s};this.settings.set({...s});await this.loadLists(token);if(token!==this.epoch)return;const m=await this.request<{items:{user_id:string;email:string;role:string}[];hasMore:boolean}>('GET',`${this.base()}/handoff-members?limit=100&offset=0`);if(token===this.epoch){this.members.set(m.items);this.moreMembers.set(m.hasMore);}});}
  selectBot(id:string){if(this.busy()||this.dirty())return;this.epoch++;this.botId=id;this.reset();return id?this.refresh():Promise.resolve();}
  collectionChanged(field:string,collect:boolean){const s=this.settings();if(s&&!collect)s['require'+field]=false;}
  cancelSettings(){if(this.saved)this.settings.set({...this.saved});this.dirty.set(false);this.settingsError.set('');}
  saveSettings(){const s=this.settings();if(!s||!this.canManage)return Promise.resolve();this.settingsError.set('');
    if(!String(s['formTitle']).trim()||!String(s['successMessage']).trim()||(s['consentRequired']&&!String(s['consentText']).trim())||(s['handoffEnabled']&&(!s['enabled']||(!s['collectEmail']&&!s['collectPhone']))) ){this.settingsError.set('Enter a title and success message. Required consent needs text. Human follow-up needs capture and email or phone enabled.');return Promise.resolve();}
    const {consentVersion:_,...body}=s;return this.perform(async token=>{const result=await this.request<Settings>('PUT',`${this.base()}/lead-settings`,body);if(token===this.epoch){this.saved={...result};this.settings.set({...result});this.dirty.set(false);this.message.set('Contact settings saved.');}});
  }
  page(handoff:boolean,delta:number){if(this.busy())return Promise.resolve();if(handoff)this.handoffOffset=Math.max(0,this.handoffOffset+25*delta);else this.leadOffset=Math.max(0,this.leadOffset+25*delta);return this.perform(t=>this.loadLists(t));}
  filterChanged(handoff:boolean){if(handoff)this.handoffOffset=0;else this.leadOffset=0;return this.perform(t=>this.loadLists(t));}
  viewLead(id:string){return this.perform(async t=>{const l=await this.request<Lead>('GET',`${this.base()}/leads/${id}`);if(t===this.epoch){this.detail.set(l);setTimeout(()=>this.detailPanel?.nativeElement.focus());}});}
  viewHandoff(id:string){return this.perform(async t=>{const h=await this.request<Handoff>('GET',`${this.base()}/handoffs/${id}`);if(t!==this.epoch)return;const l=await this.request<Lead>('GET',`${this.base()}/leads/${h.lead_id}`);if(t===this.epoch){this.handoffDetail.set(h);this.handoffLead.set(l);setTimeout(()=>this.handoffPanel?.nativeElement.focus());}});}
  setStatus(status:string){const lead=this.detail();if(!lead||!this.canManage)return Promise.resolve();return this.perform(async t=>{const l=await this.request<Lead>('PATCH',`${this.base()}/leads/${lead.id}`,{status});if(t!==this.epoch)return;this.detail.set(l);await this.loadLists(t);if(t===this.epoch)this.message.set('Lead status saved.');});}
  act(action:string,assignedUserId?:string|null){const h=this.handoffDetail();if(!h||!this.canManage)return Promise.resolve();return this.perform(async t=>{const updated=await this.request<Handoff>('PATCH',`${this.base()}/handoffs/${h.id}`,{action,revision:h.revision,...(action==='assign'?{assignedUserId}:{})});if(t!==this.epoch)return;this.handoffDetail.set(updated);await this.loadLists(t);if(t===this.epoch)this.message.set('Follow-up request updated.');});}
  memberLabel(id:string|null){return id?(this.members().find(m=>m.user_id===id)?.email || 'Organization member'):'Unassigned';}
  loadMoreMembers(){return this.perform(async t=>{const m=await this.request<{items:{user_id:string;email:string;role:string}[];hasMore:boolean}>('GET',`${this.base()}/handoff-members?limit=100&offset=${this.members().length}`);if(t===this.epoch){this.members.update(rows=>[...rows,...m.items]);this.moreMembers.set(m.hasMore);}});}
  askDelete(){if(this.detail()&&this.canManage)this.confirmation?.nativeElement.showModal();}
  cancelDelete(){this.confirmation?.nativeElement.close();}
  deleteConfirmed(){const lead=this.detail();if(!lead||!this.canManage)return Promise.resolve();return this.perform(async t=>{await this.request('DELETE',`${this.base()}/leads/${lead.id}`);if(t!==this.epoch)return;this.cancelDelete();this.detail.set(null);this.handoffDetail.set(null);this.handoffLead.set(null);this.leadOffset=0;this.handoffOffset=0;await this.loadLists(t);if(t===this.epoch)this.message.set('Lead and linked follow-up requests deleted.');});}
}
