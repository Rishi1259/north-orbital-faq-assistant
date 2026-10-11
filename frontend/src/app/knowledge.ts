import {Component,Input,OnChanges,OnDestroy,SimpleChanges,ViewChild,ElementRef,inject,signal} from '@angular/core';
import {HttpClient,HttpErrorResponse} from '@angular/common/http';
import {FormsModule} from '@angular/forms';
import {DatePipe} from '@angular/common';
import {firstValueFrom,timeout} from 'rxjs';
import {publicApiOrigin} from './chatbot-context';
interface Website {id:string;canonical_seed_url:string;status:string;job_state:string|null;page_count:number;sync_mode:string;last_successful_at:string|null;last_attempted_at:string|null;next_sync_at:string|null;latest_error_code:string|null}
interface Faq {id:string;question:string;answer:string;category:string;revision?:string}
@Component({selector:'app-knowledge',imports:[FormsModule,DatePipe],template:`
  <section aria-labelledby="knowledge-title" [attr.aria-busy]="busy()">
    <h3 id="knowledge-title">Knowledge sources</h3>
    <p>Manage public website pages and answers for each chatbot.</p>
    <p role="status" class="feedback">{{message() || (busy() ? 'Working…' : '')}}</p>
    <label for="knowledge-bot">Chatbot</label>
    <select id="knowledge-bot" [ngModel]="botId" (ngModelChange)="selectBot($event)" [disabled]="busy() || dirty()">
      <option value="">Select chatbot</option>@for(bot of bots();track bot.id){<option [value]="bot.id">{{bot.name}}</option>}
    </select>
    @if(botId){
      <button type="button" (click)="refresh()" [disabled]="busy()">Refresh sources</button>
      <h4>Websites</h4>
      @if(canManage){
        <form novalidate (ngSubmit)="addWebsite()">
          <label for="website-url">Public website URL</label><input #urlInput id="website-url" name="websiteUrl" type="url" maxlength="2048" [(ngModel)]="url" [attr.aria-invalid]="urlError() ? 'true' : null" aria-describedby="website-url-help">
          <p id="website-url-help">{{urlError() || 'Use an HTTP or HTTPS URL. Only its exact origin will be crawled.'}}</p>
          <label for="website-mode">Sync schedule</label><select id="website-mode" name="syncMode" [(ngModel)]="syncMode"><option value="manual">Manual only</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select>
          <button [disabled]="busy()">Add website</button>
        </form>
      }
      <ul class="sources">@for(site of websites();track site.id){<li>
        <strong>{{site.canonical_seed_url}}</strong><p>{{status(site)}} · {{site.page_count}} pages · {{site.sync_mode==='manual' ? 'Manual sync' : site.sync_mode==='daily' ? 'Daily sync' : 'Weekly sync'}}</p>
        <dl><dt>Last attempted</dt><dd>{{(site.last_attempted_at | date:'medium') || 'Not yet'}}</dd><dt>Last successful sync</dt><dd>{{(site.last_successful_at | date:'medium') || 'Not yet'}}</dd><dt>Next sync</dt><dd>{{(site.next_sync_at | date:'medium') || 'Manual only'}}</dd></dl>
        @if(site.latest_error_code){<p>Sync could not finish. Check that the website is public, permits crawling, and fits your plan, then try again.</p>}
        @if(canManage){
          <label [for]="'schedule-'+site.id">Sync schedule</label><select [id]="'schedule-'+site.id" [ngModel]="site.sync_mode" (ngModelChange)="schedule(site,$event)" [disabled]="busy()"><option value="manual">Manual only</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select>
          <button (click)="sync(site)" [disabled]="busy() || !!site.job_state || site.status==='disabled'">Sync now</button>
          <button (click)="toggle(site)" [disabled]="busy()">{{site.status==='disabled'?'Enable':'Disable'}}</button>
          <button (click)="askDelete(site.id,site.canonical_seed_url,false)" [disabled]="busy()">Delete website</button>
        }
      </li>}@empty{<li>No website sources yet.</li>}</ul>
      <button (click)="page('website',-1)" [disabled]="busy() || websiteOffset===0">Previous websites</button><button (click)="page('website',1)" [disabled]="busy() || websites().length<25">Next websites</button>
      <h4>Manual FAQs</h4>
      @if(canManage){
        <form novalidate (ngSubmit)="saveFaq()">
          <label for="faq-question">Question</label><input #questionInput id="faq-question" name="question" maxlength="500" [(ngModel)]="question" [attr.aria-invalid]="faqError() ? 'true' : null" aria-describedby="faq-help">
          <label for="faq-answer">Answer</label><textarea id="faq-answer" name="answer" rows="8" style="resize: none" maxlength="8000" [(ngModel)]="answer" [attr.aria-invalid]="faqError() ? 'true' : null" aria-describedby="faq-help"></textarea>
          <label for="faq-category">Category (optional)</label><input id="faq-category" name="category" maxlength="100" [(ngModel)]="category">
          <p id="faq-help">{{faqError() || 'Questions: up to 500 characters. Answers: up to 8,000 characters.'}}</p>
          <button [disabled]="busy()">{{editingId ? 'Save FAQ' : 'Add FAQ'}}</button>@if(dirty()){<button type="button" (click)="cancelEdit()" [disabled]="busy()">Cancel changes</button>}
        </form>
      }
      <ul class="sources">@for(faq of faqs();track faq.id){<li><strong>{{faq.question}}</strong><p class="answer">{{faq.answer}}</p>@if(faq.category){<p>{{faq.category}}</p>}
        @if(canManage){<button (click)="edit(faq)" [disabled]="busy() || dirty()">Edit FAQ</button><button (click)="askDelete(faq.id,faq.question,true)" [disabled]="busy()">Delete FAQ</button>}
      </li>}@empty{<li>No manual FAQs yet.</li>}</ul>
      <button (click)="page('faq',-1)" [disabled]="busy() || faqOffset===0">Previous FAQs</button><button (click)="page('faq',1)" [disabled]="busy() || faqs().length<25">Next FAQs</button>
    }
    <dialog #confirmation aria-labelledby="delete-title" aria-describedby="delete-description" (cancel)="cancelDelete()">
      <h4 id="delete-title">Delete {{deleting()?.faq ? 'FAQ' : 'website'}}?</h4><p id="delete-description">{{deleting()?.name}} will be removed from answers. Website deletion also removes its pages and pending sync work.</p>
      <button autofocus (click)="cancelDelete()" [disabled]="busy()">Cancel</button><button class="danger" (click)="deleteConfirmed()" [disabled]="busy()">Delete source</button>
    </dialog>
  </section>`,styles:[`
    :host{display:block}section{border-top:1px solid var(--admin-border);margin-top:2rem;padding-top:1rem;color:var(--admin-text)}
    label{display:block;margin-top:1rem}input,select,textarea{box-sizing:border-box;display:block;width:min(100%,36rem);padding:.6rem;font:inherit}textarea{resize:none}
    button{padding:.6rem .8rem;margin:.4rem .4rem .4rem 0;cursor:pointer}button:disabled{cursor:default;opacity:.6}button:enabled:hover{background:var(--admin-muted)}button:enabled:active{transform:translateY(1px)}
    :focus-visible{outline:3px solid var(--admin-primary);outline-offset:2px}.feedback{min-height:1.5em}.sources{list-style:none;padding:0}.sources li{padding:1rem 0;border-bottom:1px solid var(--admin-border);overflow-wrap:anywhere}
    dl{display:grid;grid-template-columns:minmax(7rem,1fr) 2fr;gap:.3rem}dd{margin:0}.answer{white-space:pre-wrap}dialog{max-width:min(32rem,80vw);max-height:80vh;overflow:auto;border:1px solid var(--admin-border);border-radius:12px;padding:1.5rem}dialog::backdrop{background:#17203380}.danger{color:var(--admin-danger)}
  `]})
export class Knowledge implements OnChanges,OnDestroy {
  @Input({required:true}) organizationId='';@Input() csrf='';@Input() canManage=false;
  @ViewChild('confirmation') confirmation?:ElementRef<HTMLDialogElement>;@ViewChild('urlInput') urlInput?:ElementRef<HTMLInputElement>;@ViewChild('questionInput') questionInput?:ElementRef<HTMLInputElement>;
  private http=inject(HttpClient);private epoch=0;
  bots=signal<{id:string;name:string}[]>([]);websites=signal<Website[]>([]);faqs=signal<Faq[]>([]);busy=signal(false);message=signal('');urlError=signal('');faqError=signal('');
  deleting=signal<{id:string;name:string;faq:boolean}|null>(null);
  botId='';url='';syncMode='manual';question='';answer='';category='';editingId='';editingRevision:string|undefined;websiteOffset=0;faqOffset=0;
  ngOnChanges(changes:SimpleChanges){if(!changes['organizationId'])return;this.epoch++;this.botId='';this.websites.set([]);this.faqs.set([]);this.cancelEdit();this.busy.set(false);void this.perform(async token=>{const r=await this.request<{chatbots:{id:string;name:string}[]}>('GET',`/organizations/${this.organizationId}/chatbots`);if(token===this.epoch)this.bots.set(r.chatbots);});}
  ngOnDestroy(){this.epoch++;}
  dirty(){return !!(this.question||this.answer||this.category||this.editingId);}
  private base(){return `/organizations/${this.organizationId}/chatbots/${this.botId}`;}
  private request<T>(method:string,path:string,body?:unknown){return firstValueFrom(this.http.request<T>(method,`${publicApiOrigin()}/api${path}`,{body,withCredentials:true,headers:{'X-CSRF-Token':this.csrf}}).pipe(timeout(60000)));}
  private async perform(work:(token:number)=>Promise<void>){if(this.busy())return;const token=this.epoch;this.busy.set(true);this.message.set('');try{await work(token);}catch(e){if(token===this.epoch)this.message.set(e instanceof HttpErrorResponse && e.status===401?'Session expired. Sign in again.':e instanceof HttpErrorResponse && e.status===409?'This source changed. Refresh before saving again.':e instanceof HttpErrorResponse && e.status===429?'Plan or request limit reached. Check account usage and try again later.':'Request failed. Your changes are preserved; refresh and try again.');}finally{if(token===this.epoch)this.busy.set(false);}}
  private async load(token:number){const [sites,faqs]=await Promise.all([this.request<{items:Website[]}>('GET',`${this.base()}/website-sources?limit=25&offset=${this.websiteOffset}`),this.request<{items:Faq[]}>('GET',`${this.base()}/manual-faqs?limit=25&offset=${this.faqOffset}`)]);if(token===this.epoch){this.websites.set(sites.items);this.faqs.set(faqs.items);}}
  selectBot(id:string){if(this.dirty()||this.busy())return;this.botId=id;this.websiteOffset=0;this.faqOffset=0;this.websites.set([]);this.faqs.set([]);return id?this.refresh():Promise.resolve();}
  refresh(){return this.perform(token=>this.load(token));}
  addWebsite(){this.urlError.set('');try{const url=new URL(this.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw 0;}catch{this.urlError.set('Enter a valid public HTTP or HTTPS URL without credentials.');this.urlInput?.nativeElement.focus();return Promise.resolve();}
    return this.perform(async token=>{await this.request('POST',`${this.base()}/website-sources`,{url:this.url,syncMode:this.syncMode});if(token!==this.epoch)return;this.url='';this.websiteOffset=0;await this.load(token);this.message.set('Website added. Sync is queued.');});}
  sync(site:Website){return this.perform(async token=>{await this.request('POST',`${this.base()}/website-sources/${site.id}/sync`,{});await this.load(token);if(token===this.epoch)this.message.set('Sync queued. Refresh to check progress.');});}
  schedule(site:Website,syncMode:string){return this.perform(async token=>{await this.request('PATCH',`${this.base()}/website-sources/${site.id}`,{syncMode});await this.load(token);});}
  toggle(site:Website){return this.perform(async token=>{await this.request('PATCH',`${this.base()}/website-sources/${site.id}`,{disabled:site.status!=='disabled'});await this.load(token);});}
  status(site:Website){return site.status==='disabled'?'Disabled':site.job_state==='queued'?'Queued':site.job_state==='running'?'Crawling':site.status==='ready'?'Ready':site.status==='failed'?'Sync failed':'Pending';}
  edit(faq:Faq){this.editingId=faq.id;this.editingRevision=faq.revision;this.question=faq.question;this.answer=faq.answer;this.category=faq.category;this.questionInput?.nativeElement.focus();}
  cancelEdit(){this.editingId='';this.editingRevision=undefined;this.question='';this.answer='';this.category='';this.faqError.set('');}
  saveFaq(){this.faqError.set('');if(!this.question.trim()||!this.answer.trim()||this.question.length>500||this.answer.length>8000){this.faqError.set('Enter a question and answer within the limits.');this.questionInput?.nativeElement.focus();return Promise.resolve();}
    return this.perform(async token=>{await this.request(this.editingId?'PUT':'POST',`${this.base()}/manual-faqs${this.editingId?'/'+this.editingId:''}`,{question:this.question,answer:this.answer,category:this.category,...(this.editingRevision?{revision:this.editingRevision}:{})});if(token!==this.epoch)return;this.cancelEdit();this.faqOffset=0;await this.load(token);this.message.set('FAQ saved and ready for answers.');});}
  page(kind:string,direction:number){if(kind==='website')this.websiteOffset=Math.max(0,this.websiteOffset+direction*25);else this.faqOffset=Math.max(0,this.faqOffset+direction*25);return this.refresh();}
  askDelete(id:string,name:string,faq:boolean){this.deleting.set({id,name,faq});this.confirmation?.nativeElement.showModal();}
  cancelDelete(){this.confirmation?.nativeElement.close();this.deleting.set(null);}
  deleteConfirmed(){const item=this.deleting();if(!item)return Promise.resolve();return this.perform(async token=>{await this.request('DELETE',`${this.base()}/${item.faq?'manual-faqs':'website-sources'}/${item.id}`);if(token!==this.epoch)return;this.cancelDelete();this.websiteOffset=0;this.faqOffset=0;if(this.editingId===item.id)this.cancelEdit();await this.load(token);this.message.set('Source deleted. It is no longer used in answers.');});}
}
