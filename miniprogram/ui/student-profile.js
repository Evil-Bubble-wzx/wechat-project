const api=require('../services/api'),host=require('../services/host'),profiles=require('../modules/profile/student-profile')
const blank=()=>({profile:null,studentCode:'',reason:'',confirmed:false,canManage:false,campuses:[],grades:[],levels:[],campusIndex:0,gradeIndex:0,levelIndex:0})
function createPage(){
 return{
  data:{route:'student-profile',title:'Student Profiles',inset:24,isTab:false,isDemo:host.policy().isDemo,sheet:'',...blank(),status:'idle',notice:'',busy:false,locked:false},
  onLoad(){this.owner=api.currentUser()?.userId||null;this.setData({inset:host.inset()})},
  current(){return !this.closed&&!this.data.isDemo&&!!this.owner&&api.isAuthenticated()&&api.currentUser()?.userId===this.owner&&host.accountScope()===this.owner},
  wipe(notice){this.epoch=(this.epoch||0)+1;this.pending=null;this.setData({...blank(),status:'forbidden',notice,busy:false,locked:false})},
  onShow(){if(!this.owner)this.owner=api.currentUser()?.userId||null;if(!this.current()){this.wipe('请使用原正式账号重新打开此页。');return}return this.bootstrap()},
  onHide(){this.epoch=(this.epoch||0)+1;this.setData({busy:false})},
  onUnload(){this.closed=true;this.epoch=(this.epoch||0)+1;this.pending=null},
  back(){host.back()},noop(){},
  fail(error,fallback){if(error.serverCode==='FORBIDDEN'||error.serverCode==='UNAUTHENTICATED'){this.wipe('当前账号没有档案维护权限。');return}this.setData({status:'error',notice:fallback})},
  async bootstrap(){
   if(!this.current())return
   if(!api.studentProfileAvailable()){this.setData({status:'unavailable',notice:'请先升级提供档案管理接口的后端。'});return}
   const epoch=this.epoch=(this.epoch||0)+1,current=()=>this.current()&&epoch===this.epoch
   this.setData({busy:true,notice:'',canManage:false})
   try{
    const own=await api.studentProfile();if(!current())return
    if(own.canManage!==true){this.wipe('仅运营管理员可维护学生档案。');return}
    const options=await api.studentProfileOptions();if(!current())return
    this.options=options
    this.setData({canManage:true,status:'ready'})
    if(this.data.profile){this.setData({busy:false});await this.readProfile(this.data.profile.studentCode)}
   }catch(error){if(current())this.fail(error,'权限或选项加载失败，请重试。')}
   finally{if(current())this.setData({busy:false})}
  },
  typeCode(e){if(this.data.busy||this.pending)return;this.setData({studentCode:String(e.detail.value||'').trim().slice(0,40),profile:null,locked:false,confirmed:false,notice:''})},
  typeReason(e){if(!this.data.busy&&!this.pending&&!this.data.locked)this.setData({reason:String(e.detail.value||'').slice(0,256)})},
  choose(e,key){if(!this.data.busy&&!this.pending&&!this.data.locked)this.setData({[key]:Number(e.detail.value),confirmed:false})},
  chooseCampus(e){this.choose(e,'campusIndex')},chooseGrade(e){this.choose(e,'gradeIndex')},chooseLevel(e){this.choose(e,'levelIndex')},
  confirm(){if(!this.data.busy&&!this.pending&&!this.data.locked)this.setData({confirmed:!this.data.confirmed})},
  setProfile(value){
   const p=profiles.normalize(value),options=this.options||{}
   const campuses=[{value:null,label:'Unassigned'},...(options.campuses||[])]
   if(p.campusId&&!campuses.some(item=>item.value===p.campusId))campuses.push({value:p.campusId,label:p.campusLabel+' (inactive)'})
   const grades=[{value:null,label:'Pending'},...(options.grades||[])],levels=[{value:null,label:'Pending'},...(options.readingLevels||[])]
   this.setData({profile:p,campuses,grades,levels,campusIndex:Math.max(0,campuses.findIndex(item=>item.value===p.campusId)),gradeIndex:Math.max(0,grades.findIndex(item=>item.value===p.grade)),levelIndex:Math.max(0,levels.findIndex(item=>item.value===p.readingLevel)),reason:'',confirmed:false,locked:false,status:'ready'})
  },
  async lookup(){
   if(this.data.busy||this.pending||!this.current()||!this.data.canManage)return
   const target=this.data.studentCode
   if(!/^student_[a-f0-9]{32}$/.test(target)){this.setData({notice:'请输入学生本人 Me 页显示的完整 Student Code。'});return}
   return this.readProfile(target)
  },
  async readProfile(target){
   const epoch=this.epoch=(this.epoch||0)+1,current=()=>this.current()&&this.epoch===epoch
   this.setData({busy:true,notice:''})
   try{
    const result=await api.findStudentProfile(target);if(!current())return
    if(result.profile?.studentCode!==target)throw Error('profile_scope_mismatch')
    this.pending=null;this.setProfile(result.profile)
   }catch(error){if(current())this.fail(error,'档案加载失败；请检查查询码或重试。')}
   finally{if(current())this.setData({busy:false})}
  },
  reload(){if(!this.current()||this.data.busy)return;if(!this.data.canManage)return this.bootstrap();return this.readProfile(this.data.profile?.studentCode||this.data.studentCode)},
  save(){
   if(!this.current()||this.data.busy||!this.data.canManage||this.pending||this.data.locked||!this.data.profile)return
   if(!this.data.confirmed||!this.data.reason.trim()){this.setData({notice:'请填写变更依据，并确认已核对学生身份与档案。'});return}
   const campusId=this.data.campuses[this.data.campusIndex]?.value
   if(campusId!==null&&!this.options.campuses.some(item=>item.value===campusId)){this.setData({notice:'请选择仍有效的校区，或明确解除归属。'});return}
   const mutation={mutationId:'profile-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),baseRevision:this.data.profile.revision,campusId,
    grade:campusId===null?null:this.data.grades[this.data.gradeIndex].value,readingLevel:campusId===null?null:this.data.levels[this.data.levelIndex].value,reason:this.data.reason.trim()}
   this.pending={owner:this.owner,studentCode:this.data.profile.studentCode,mutation:Object.freeze(mutation)}
   return this.submit()
  },
  retry(){if(this.pending)return this.submit();return this.data.canManage?this.reload():this.bootstrap()},
  async submit(){
   const pending=this.pending;if(!pending||!this.current()||pending.owner!==this.owner||this.data.busy)return
   const epoch=this.epoch=(this.epoch||0)+1,current=()=>this.current()&&epoch===this.epoch&&this.pending===pending
   this.setData({busy:true,notice:'',locked:true})
   try{
    const result=await api.updateStudentProfile(pending.studentCode,pending.mutation);if(!current())return
    if(!['applied','unchanged'].includes(result.status)||result.profile?.studentCode!==pending.studentCode)throw Error('profile_scope_mismatch')
    const profile=profiles.normalize(result.profile);this.pending=null;this.setProfile(profile);this.setData({notice:result.status==='applied'?'档案已保存；榜单按期初档案，下期体现新归属。':'档案未变化，无重复版本。'})
   }catch(error){
    if(!current())return
    if(error.serverCode==='CONFLICT'||error.serverCode==='IDEMPOTENCY_KEY_REUSED'){this.pending=null;this.setData({status:'conflict',locked:true,notice:'档案已变化，请重新加载、核对后提交；不会覆盖他人的更新。'})}
    else this.fail(error,'结果尚未确认，可重试原请求，或重新加载以查看服务端最新档案。')
   }finally{if(this.current()&&epoch===this.epoch)this.setData({busy:false})}
  }
 }
}
module.exports={createPage}
