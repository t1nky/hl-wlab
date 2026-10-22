// Standalone GoldSrc BSP collision and CS shooting experiment.
// Hull traversal is adapted from ReHLDS world.cpp (see web/THIRD-PARTY.md).
// Ballistic rules follow ReGameDLL_CS 5.30.0.814 FireBullets3 (GPL-3.0).
// This module is GPL-3.0-or-later. See web/THIRD-PARTY.md for provenance and limits.
#include <stdint.h>
#ifdef __wasm__
#define API extern "C" __attribute__((visibility("default")))
extern "C" __attribute__((import_module("math"),import_name("pow"))) double host_pow(double,double);
extern "C" __attribute__((import_module("math"),import_name("sin"))) double host_sin(double);
extern "C" __attribute__((import_module("math"),import_name("cos"))) double host_cos(double);
#else
#include <cmath>
#include <cstdio>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif
#define API extern "C"
static double host_pow(double a,double b){return std::pow(a,b);}
static double host_sin(double a){return std::sin(a);}
static double host_cos(double a){return std::cos(a);}
#endif

struct V {
 float x,y,z;
 float& operator[](int i){return (&x)[i];}
 float operator[](int i)const{return (&x)[i];}
};
static V operator+(V a,V b){return {a.x+b.x,a.y+b.y,a.z+b.z};}
static V operator-(V a,V b){return {a.x-b.x,a.y-b.y,a.z-b.z};}
static V operator*(V a,float b){return {a.x*b,a.y*b,a.z*b};}
static float dot(V a,V b){return a.x*b.x+a.y*b.y+a.z*b.z;}
static float absf(float x){return x<0?-x:x;}
static float clamp(float x,float a,float b){return x<a?a:x>b?b:x;}
static float length(V v){return __builtin_sqrtf(dot(v,v));}

// The BSP is staged after the static data; linear memory grows to fit the map
// instead of reserving the 32 MiB maximum up front.
static const int MAX_MAP=32*1024*1024;
static const uint8_t* input;
#ifdef __wasm__
extern "C" unsigned char __heap_base;
static uint8_t* stage(int size){
 uintptr_t base=(uintptr_t)&__heap_base,needed=base+size,have=(uintptr_t)__builtin_wasm_memory_size(0)*65536;
 if(needed>have && __builtin_wasm_memory_grow(0,(needed-have+65535)/65536)<0)return 0;
 return (uint8_t*)base;
}
#else
static uint8_t storage[MAX_MAP];
static uint8_t* stage(int){return storage;}
#endif
static float jobs[4096*6],results[4096*14],scratch[128];
static int offset[15],bytes[15];
static uint16_t u16(int p){return input[p]|(input[p+1]<<8);}
static int16_t i16(int p){return (int16_t)u16(p);}
static uint32_t u32(int p){return input[p]|(uint32_t(input[p+1])<<8)|(uint32_t(input[p+2])<<16)|(uint32_t(input[p+3])<<24);}
static int32_t i32(int p){return (int32_t)u32(p);}
static float f32(int p){union {uint32_t u;float f;}v;v.u=u32(p);return v.f;}
static V vec(int p){return {f32(p),f32(p+4),f32(p+8)};}

struct Plane{V n;float d;int type;};
// Each node carries its plane so a traversal step touches one record.
struct Node{Plane p;int c[2],first,count;};
struct Brush{int roots[4],solid;V origin,axes[3],lo,hi;};
struct Candidate{int brush;V lo[4],hi[4];};
// Bounding-volume tree over the solid brush entities; leaves hold index ranges
// of `order`. Visiting it only skips brushes whose expanded bounds the segment
// bounds miss, so the surviving brushes are exactly those the engine's
// per-entity box test accepts; they are then traced in index order.
struct Volume{V lo[4],hi[4];int child[2],first,count;};
struct Face{V s,t;float so,to,mins,maxt,mint,maxs;int texture;};
static Node nodes[65536],clips[65536];
static Brush brushes[1024];
static Face faces[65536];
static Candidate candidates[1024];
static Volume volumes[2048];static int order[1024],nvol;
static int materials[4096],np,nn,nc,nm,nf,ncand;

struct Hull{const Node* nodes;int root;};
struct Trace{float f;V end,normal;int start,all,ent,group;};
static float pdist(const Plane&p,V a){
 float axial=p.type==0?a.x:p.type==1?a.y:a.z;
 return (p.type<3?axial:dot(p.n,a))-p.d;
}
static int contents(const Hull&h,int n,V p){
 for(int steps=0; n>=0 && steps<65536;steps++)n=h.nodes[n].c[pdist(h.nodes[n].p,p)<0];
 return n;
}
// SV_RecursiveHullCheck with an explicit stack: the engine recursion first
// descends the near side; when that side ends in a non-solid leaf it resumes
// the far side from the split point, unless the split point is solid, which
// is the hit. Float operations, their order and the engine's depth guard are
// unchanged. Deliberately uses the 1/32-unit collision bias, including backup.
struct Split{int far,plane,side,depth;float a,b,f,mf;V s,e,m;};
static bool hullcheck(const Hull&h,int n,float a,float b,V s,V e,Trace&t){
 Split stack[257];int pending=0,depth=0;
 for(;;){
  if(depth>256){t.start=t.all=1;return false;}
  if(n<0){
   if(n!=-2)t.all=0;else t.start=1;
   if(!pending)return true;
   const Split&r=stack[--pending];
   if(contents(h,r.far,r.m)!=-2){n=r.far;a=r.mf;b=r.b;s=r.m;e=r.e;depth=r.depth+1;continue;}
   if(t.all)return false;
   t.normal=h.nodes[r.plane].p.n*(r.side?-1.f:1.f);
   float f=r.f,mf=r.mf;V m=r.m;
   while(contents(h,h.root,m)==-2){
    f-=.1f;
    if(f<0){t.f=mf;t.end=m;return false;}
    mf=r.a+(r.b-r.a)*f;m=r.s+(r.e-r.s)*f;
   }
   t.f=mf;t.end=m;return false;
  }
  const Node&node=h.nodes[n];
  float d1=pdist(node.p,s),d2=pdist(node.p,e);
  if(d1>=0 && d2>=0){n=node.c[0];depth++;continue;}
  if(d1<0 && d2<0){n=node.c[1];depth++;continue;}
  float f=clamp((d1+(d1<0?.03125f:-.03125f))/(d1-d2),0,1),mf=a+(b-a)*f;
  V m=s+(e-s)*f;int side=d1<0;
  stack[pending++]={node.c[side^1],n,side,depth,a,b,f,mf,s,e,m};
  n=node.c[side];b=mf;e=m;depth++;
 }
}

static V local(const Brush&b,V p){p=p-b.origin;return {dot(p,b.axes[0]),dot(p,b.axes[1]),dot(p,b.axes[2])};}
static V globaldir(const Brush&b,V p){return b.axes[0]*p.x+b.axes[1]*p.y+b.axes[2]*p.z;}
static Trace brushtrace(int id,V s,V e,int hull){
 const Brush&b=brushes[id];
 Hull h{hull?clips:nodes,b.roots[hull]};
 Trace t{1,e,{},0,1,id,0};
 V ls=local(b,s),le=local(b,e);
 hullcheck(h,h.root,0,1,ls,le,t);
 t.normal=globaldir(b,t.normal);
 t.end=s+(e-s)*t.f;
 return t;
}
static int buildVolume(int first,int count){
 Volume&v=volumes[nvol];int id=nvol++;
 for(int h=0;h<4;h++){v.lo[h]={1e30f,1e30f,1e30f};v.hi[h]={-1e30f,-1e30f,-1e30f};}
 for(int i=first;i<first+count;i++){
  const Candidate&c=candidates[order[i]];
  for(int h=0;h<4;h++)for(int j=0;j<3;j++){if(c.lo[h][j]<v.lo[h][j])v.lo[h][j]=c.lo[h][j];if(c.hi[h][j]>v.hi[h][j])v.hi[h][j]=c.hi[h][j];}
 }
 v.first=first;v.count=count;v.child[0]=v.child[1]=-1;
 if(count<=4)return id;
 int axis=0;V size=v.hi[0]-v.lo[0];
 if(size.y>size[axis])axis=1;
 if(size.z>size[axis])axis=2;
 // Partial insertion sort by center along the widest axis, then median split.
 for(int i=first+1;i<first+count;i++){
  int k=order[i];float key=candidates[k].lo[0][axis]+candidates[k].hi[0][axis];int j=i-1;
  while(j>=first && candidates[order[j]].lo[0][axis]+candidates[order[j]].hi[0][axis]>key){order[j+1]=order[j];j--;}
  order[j+1]=k;
 }
 int half=count/2;
 int left=buildVolume(first,half),right=buildVolume(first+half,count-half);
 volumes[id].child[0]=left;volumes[id].child[1]=right;
 return id;
}
// Solid brush entities in index order, with bounds pre-expanded by the
// engine's per-hull margin (1 for the point hull, 40 for player hulls).
static void rebuildCandidates(){
 ncand=0;nvol=0;
 for(int i=1;i<nm;i++){
  if(!brushes[i].solid)continue;
  order[ncand]=ncand;Candidate&c=candidates[ncand++];c.brush=i;
  for(int h=0;h<4;h++){float expand=h?40:1;for(int j=0;j<3;j++){c.lo[h][j]=brushes[i].lo[j]-expand;c.hi[h][j]=brushes[i].hi[j]+expand;}}
 }
 if(ncand)buildVolume(0,ncand);
}
static bool outside(V lo,V hi,V boxLo,V boxHi){return hi.x<boxLo.x||lo.x>boxHi.x||hi.y<boxLo.y||lo.y>boxHi.y||hi.z<boxLo.z||lo.z>boxHi.z;}
// Brushes whose expanded bounds overlap the segment bounds, ascending by index.
static int overlapping(V lo,V hi,int hull,int*out){
 if(!ncand)return 0;
 int stack[64],pending=1,found=0;stack[0]=0;
 while(pending){
  const Volume&v=volumes[stack[--pending]];
  if(outside(lo,hi,v.lo[hull],v.hi[hull]))continue;
  if(v.child[0]<0){
   for(int i=v.first;i<v.first+v.count;i++){
    const Candidate&c=candidates[order[i]];
    if(outside(lo,hi,c.lo[hull],c.hi[hull]))continue;
    int j=found++;
    while(j>0 && out[j-1]>c.brush){out[j]=out[j-1];j--;}
    out[j]=c.brush;
   }
   continue;
  }
  stack[pending++]=v.child[0];stack[pending++]=v.child[1];
 }
 return found;
}
// SV_Move first clips to world, then traces entities only to that endpoint
// and rescales their fractions. An all-solid world trace cannot be replaced.
static Trace worldtrace(V s,V e,int hull){
 Trace t=brushtrace(0,s,e,hull);
 if(t.f==0||t.all)return t;
 const float worldFraction=t.f;const V end=t.end;
 V lo=s,hi=s;
 for(int j=0;j<3;j++){if(end[j]<lo[j])lo[j]=end[j];if(end[j]>hi[j])hi[j]=end[j];}
 int hits[1024];const int found=overlapping(lo,hi,hull,hits);
 t.f=1;
 for(int k=0;k<found;k++){
  if(t.all)break;
  Trace q=brushtrace(hits[k],s,end,hull);
  if(q.all||q.start||q.f<t.f){int start=t.start;t=q;t.start|=start;}
 }
 t.f*=worldFraction;
 return t;
}
// Texture lookup traverses render BSP surfaces, separately from clip hulls.
// SurfaceAtPoint truncates texture coordinates to int before extent checks.
static int surfaceAt(const Node&node,V m){
 for(int i=node.first;i<node.first+node.count;i++){
  const Face&face=faces[i];
  int u=int(dot(face.s,m)+face.so),v=int(dot(face.t,m)+face.to);
  if(u>=face.mins && u<=face.maxs && v>=face.mint && v<=face.maxt)return face.texture;
 }
 return -1;
}
struct Crossing{int node,far,depth;V m,e;};
static int surface(int n,V s,V e){
 Crossing stack[257];int pending=0,depth=0;
 for(;;){
  if(n<0||depth>256){
   if(!pending)return -1;
   const Crossing&c=stack[--pending];
   int hit=surfaceAt(nodes[c.node],c.m);
   if(hit>=0)return hit;
   n=c.far;s=c.m;e=c.e;depth=c.depth+1;continue;
  }
  const Node&node=nodes[n];
  float a=pdist(node.p,s),b=pdist(node.p,e);int side=a<0;
  if((b<0)==side){n=node.c[side];depth++;continue;}
  float f=a/(a-b);V m=s+(e-s)*f;
  stack[pending++]={n,node.c[side^1],depth,m,e};
  n=node.c[side];e=m;depth++;
 }
}
static int material(int id,V s,V e){
 if(id<0||id>=nm)return 'C';
 int tex=surface(brushes[id].roots[0],local(brushes[id],s),local(brushes[id],e));
 return tex>=0 && tex<4096?materials[tex]:'C';
}

// A hitbox is a six-node chain hull: the outer side of every plane is empty,
// the inner side of the last plane is solid.
struct Hitbox{Node chain[6];int group;V lo,hi;};
static Hitbox boxes[128];static int nb;static V aims[3];
static V boxesLo,boxesHi; // union of all hitbox world bounds
// Skipping a hitbox trace is exact in two cases. The traversal classifies
// points on the segment, each at most 1/32 unit plus float rounding outside a
// plane, so when the slab test on the box's own plane distances with a
// 1/2-unit margin finds no overlap the traversal cannot report solid and the
// result is the fixed miss. When the ray enters the expanded slabs only after
// the best hit so far, the box cannot start or fully enclose the segment and
// any hit it reports lies at a larger fraction, so it cannot replace the best
// (the first box always replaces the initial best, whose fraction is 1).
// The world bounds (1-unit margin) are a cheap prefilter.
static const float MARGIN=.5f;
static void hitboxBounds(Hitbox&b){
 double m[3][3],lo[3],hi[3];
 for(int j=0;j<3;j++){const V&n=b.chain[j*2].p.n;m[j][0]=n.x;m[j][1]=n.y;m[j][2]=n.z;lo[j]=b.chain[j*2+1].p.d-MARGIN;hi[j]=b.chain[j*2].p.d+MARGIN;}
 double det=m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
 b.lo={-1e30f,-1e30f,-1e30f};b.hi={1e30f,1e30f,1e30f};
 if(!(det>1e-9||det<-1e-9))return;
 double inv[3][3];
 for(int r=0;r<3;r++)for(int c=0;c<3;c++){int r1=(c+1)%3,r2=(c+2)%3,c1=(r+1)%3,c2=(r+2)%3;inv[r][c]=(m[r1][c1]*m[r2][c2]-m[r1][c2]*m[r2][c1])/det;}
 double blo[3]={1e30,1e30,1e30},bhi[3]={-1e30,-1e30,-1e30};
 for(int c=0;c<8;c++){
  double y[3]={c&1?hi[0]:lo[0],c&2?hi[1]:lo[1],c&4?hi[2]:lo[2]};
  for(int k=0;k<3;k++){double x=inv[k][0]*y[0]+inv[k][1]*y[1]+inv[k][2]*y[2];if(x<blo[k])blo[k]=x;if(x>bhi[k])bhi[k]=x;}
 }
 for(int k=0;k<3;k++){b.lo[k]=float(blo[k]-1);b.hi[k]=float(bhi[k]+1);}
}
static void targetBounds(){
 boxesLo={1e30f,1e30f,1e30f};boxesHi={-1e30f,-1e30f,-1e30f};
 for(int i=0;i<nb;i++)for(int k=0;k<3;k++){if(boxes[i].lo[k]<boxesLo[k])boxesLo[k]=boxes[i].lo[k];if(boxes[i].hi[k]>boxesHi[k])boxesHi[k]=boxes[i].hi[k];}
}
static bool skipBox(const Hitbox&b,V s,V e,V lo,V hi,float bestFraction){
 if(outside(lo,hi,b.lo,b.hi))return true;
 float tmin=0,tmax=1;
 for(int j=0;j<3;j++){
  const Plane&max=b.chain[j*2].p,&min=b.chain[j*2+1].p;
  float o=dot(max.n,s),d=dot(max.n,e)-o,l=min.d-MARGIN,u=max.d+MARGIN;
  if(d==0){if(o<l||o>u)return true;continue;}
  float t0=(l-o)/d,t1=(u-o)/d;
  if(t0>t1){float x=t0;t0=t1;t1=x;}
  if(t0>tmin)tmin=t0;
  if(t1<tmax)tmax=t1;
  if(tmin>tmax)return true;
 }
 return tmin>bestFraction;
}
static Trace targettrace(V s,V e){
 Trace best{1,e,{},0,0,-1,0};
 V lo=s,hi=s;
 for(int j=0;j<3;j++){if(e[j]<lo[j])lo[j]=e[j];if(e[j]>hi[j])hi[j]=e[j];}
 const bool all=outside(lo,hi,boxesLo,boxesHi);
 for(int i=0;i<nb;i++){
  Trace q{1,e,{},0,1,-2,boxes[i].group};
  if(all||skipBox(boxes[i],s,e,lo,hi,best.f))q.all=0;else hullcheck({boxes[i].chain,0},0,0,1,s,e,q);
  if(i==0||q.all||q.start||q.f<best.f){int start=best.start;best=q;best.start|=start;}
 }
 return best;
}

struct Shot{float raw;int group,walls,anchor;};
struct Weapon{int damage;float range;int impacts,power;float penetrationDistance,rangeModifier;int buckshot;};
static Weapon weapon{115,8192,3,45,8000,.99f,0};
API int set_weapon(int damage,float range,int impacts,int power,float penetrationDistance,float rangeModifier,int buckshot){
 if(!(damage>0&&damage<=1000&&range>=1&&range<=8192&&impacts>=1&&impacts<=8&&power>=0&&power<=128&&penetrationDistance>=0&&penetrationDistance<=8192&&rangeModifier>0&&rangeModifier<=1&&(buckshot==0||buckshot==1)))return 0;
 weapon={damage,range,impacts,power,penetrationDistance,rangeModifier,buckshot};return 1;
}
static float hitgroupDamage(float raw,int group){
 switch(group){case 1:raw*=4;break;case 3:raw*=1.25f;break;case 6:case 7:raw*=.75f;break;case 8:raw=0;break;}
 return raw;
}
static Shot shoot(V eye,V aim){
 V dir=aim-eye;float len=length(dir);
 if(len<1||len>weapon.range)return {};
 dir=dir*(1/len);
 if(targettrace(eye,eye+dir*weapon.range).f>=1)return {};
 if(weapon.buckshot){
  Trace tr=worldtrace(eye,eye+dir*weapon.range,0);
  if(tr.all||tr.f==0)return {};
  Trace hit=targettrace(eye,tr.end);
  if(!(hit.all||hit.start||hit.f<1))return {};
  hit.f*=tr.f;
  return {hitgroupDamage(int((1-hit.f)*weapon.damage),hit.group),hit.group,0,0};
 }
 int damage=weapon.damage,pen=weapon.impacts,power=weapon.power,walls=0;float range=weapon.range,modifier=.5f;V s=eye;
 while(pen && damage>0){
  V e=s+dir*range;
  Trace tr=worldtrace(s,e,0);
  if(!tr.all&&tr.f!=0){
   Trace hit=targettrace(s,tr.end);
   if(hit.all||hit.start||hit.f<1){hit.f*=tr.f;hit.start|=tr.start;tr=hit;}
  }
  if(tr.f>=1)return {};
  int mat=tr.ent==-2?'C':material(tr.ent,s,e);
  switch(mat){
   case 'M':power=int(power*.15f);modifier=.2f;break;
   case 'C':power=int(power*.25f);break;
   case 'G':power=int(power*.5f);modifier=.4f;break;
   case 'V':power=int(power*.5f);modifier=.45f;break;
   case 'T':power=int(power*.65f);modifier=.3f;break;
   case 'P':power=int(power*.4f);modifier=.45f;break;
   case 'W':modifier=.6f;break;
  }
  pen--;
  float distance=tr.f*range;
  damage=int(float(damage)*host_pow(weapon.rangeModifier,distance/500.f));
  if(distance>weapon.penetrationDistance)pen=0;
  if(tr.ent==-2){
   return {hitgroupDamage(damage,tr.group),tr.group,walls,0};
  }
  if(!pen)return {};
  s=tr.end+dir*float(power);
  range=(range-distance)*.5f;
  damage=int(damage*modifier);
  walls++;
 }
 return {};
}

API uintptr_t map_ptr(int size){if(size<0||size>MAX_MAP)return 0;input=stage(size);return (uintptr_t)input;}
API uintptr_t jobs_ptr(){return (uintptr_t)jobs;}
API uintptr_t results_ptr(){return (uintptr_t)results;}
API uintptr_t io_ptr(){return (uintptr_t)scratch;}
API int map_load(int size){
 if(!input||size<124||size>MAX_MAP||i32(0)!=30)return 0;
 const int strides[15]={1,20,1,12,1,24,40,20,1,8,28,2,4,4,64};
 for(int i=0;i<15;i++){
  offset[i]=i32(4+i*8);bytes[i]=i32(8+i*8);
  if(offset[i]<0||bytes[i]<0||offset[i]>size-bytes[i]||bytes[i]%strides[i])return 0;
 }
 np=bytes[1]/20;nn=bytes[5]/24;nc=bytes[9]/8;nm=bytes[14]/64;nf=bytes[7]/20;
 if(!np||np>65536||!nn||nn>65536||nc>65536||!nm||nm>1024||nf>65536)return 0;
 static Plane planes[65536];
 for(int i=0;i<np;i++){
  int p=offset[1]+i*20;
  planes[i]={vec(p),f32(p+12),i32(p+16)};
  if(planes[i].type<0||planes[i].type>5)return 0;
 }
 for(int i=0;i<nn;i++){
  int p=offset[5]+i*24,plane=i32(p);Node&n=nodes[i];
  if(plane<0||plane>=np)return 0;
  n={planes[plane],{i16(p+4),i16(p+6)},u16(p+20),u16(p+22)};
  if(n.first+n.count>nf)return 0;
  for(int j=0;j<2;j++){
   int c=n.c[j];
   if(c>=nn||c<0 && -1-c>=bytes[10]/28)return 0;
   if(c<0)n.c[j]=i32(offset[10]+(-1-c)*28);
  }
 }
 for(int i=0;i<nc;i++){
  int p=offset[9]+i*8,plane=i32(p);
  if(plane<0||plane>=np)return 0;
  clips[i]={planes[plane],{i16(p+4),i16(p+6)},0,0};
  if(clips[i].c[0]>=nc||clips[i].c[1]>=nc)return 0;
 }
 for(int i=0;i<nm;i++){
  int p=offset[14]+i*64;Brush&b=brushes[i];
  b={};b.solid=i==0;b.lo=vec(p);b.hi=vec(p+12);
  b.axes[0]={1,0,0};b.axes[1]={0,1,0};b.axes[2]={0,0,1};
  for(int j=0;j<4;j++){b.roots[j]=i32(p+36+j*4);if(b.roots[j]>=(j?nc:nn))return 0;}
 }
 for(int i=0;i<4096;i++)materials[i]='C';
 for(int i=0;i<nf;i++){
  int p=offset[7]+i*20,ti=u16(p+10),edge=i32(p+4),count=u16(p+8);
  if(ti>=bytes[6]/40||edge<0||count<3||edge>bytes[13]/4-count)return 0;
  int t=offset[6]+ti*40;Face&f=faces[i];
  f={vec(t),vec(t+16),f32(t+12),f32(t+28),1e20f,-1e20f,1e20f,-1e20f,i32(t+32)};
  for(int j=0;j<count;j++){
   int se=i32(offset[13]+(edge+j)*4),en=se<0?-se:se;
   if(en>=bytes[12]/4)return 0;
   int vi=u16(offset[12]+en*4+(se<0?2:0));
   if(vi>=bytes[3]/12)return 0;
   V v=vec(offset[3]+vi*12);
   float u=dot(f.s,v)+f.so,w=dot(f.t,v)+f.to;
   f.mins=u<f.mins?u:f.mins;f.maxs=u>f.maxs?u:f.maxs;f.mint=w<f.mint?w:f.mint;f.maxt=w>f.maxt?w:f.maxt;
  }
  f.mins=__builtin_floorf(f.mins/16)*16;f.maxs=__builtin_ceilf(f.maxs/16)*16;
  f.mint=__builtin_floorf(f.mint/16)*16;f.maxt=__builtin_ceilf(f.maxt/16)*16;
 }
 nb=0;targetBounds();rebuildCandidates();
 return nm;
}
API void set_material(int i,int m){if(i>=0&&i<4096)materials[i]=m;}
API void set_brush(int i,int solid,float x,float y,float z,float pitch,float yaw,float roll){
 if(i<1||i>=nm)return;
 Brush&b=brushes[i];b.solid=solid;b.origin={x,y,z};
 float p=pitch*.0174532925199433f,a=yaw*.0174532925199433f,r=roll*.0174532925199433f;
 float sp=host_sin(p),cp=host_cos(p),sy=host_sin(a),cy=host_cos(a),sr=host_sin(r),cr=host_cos(r);
 b.axes[0]={cp*cy,cp*sy,-sp};
 b.axes[1]={sr*sp*cy-cr*sy,sr*sp*sy+cr*cy,sr*cp};
 b.axes[2]={cr*sp*cy+sr*sy,cr*sp*sy-sr*cy,cr*cp};
 V lo{1e20f,1e20f,1e20f},hi{-1e20f,-1e20f,-1e20f};
 int off=offset[14]+i*64;V a0=vec(off),a1=vec(off+12);
 for(int c=0;c<8;c++){
  V v=globaldir(b,{c&1?a1.x:a0.x,c&2?a1.y:a0.y,c&4?a1.z:a0.z})+b.origin;
  for(int j=0;j<3;j++){if(v[j]<lo[j])lo[j]=v[j];if(v[j]>hi[j])hi[j]=v[j];}
 }
 b.lo=lo;b.hi=hi;
 rebuildCandidates();
}
API void clear_target(){nb=0;targetBounds();}
// io = 3x4 world bone transform, local mins/maxs. Engine clienttrace expands
// each oriented plane by the projection of a 1x1x1 box at default cvar=1.
API void add_hitbox(int group,float expansion){
 if(nb>=128)return;
 Hitbox&b=boxes[nb++];b.group=group;
 for(int j=0;j<3;j++){
  V n{scratch[j],scratch[4+j],scratch[8+j]},org{scratch[3],scratch[7],scratch[11]};
  float ext=(absf(n.x)+absf(n.y)+absf(n.z))*expansion;
  b.chain[j*2].p={n,dot(n,org)+scratch[15+j]+ext,5};
  b.chain[j*2+1].p={n,dot(n,org)+scratch[12+j]-ext,5};
 }
 for(int j=0;j<6;j++){b.chain[j].c[0]=b.chain[j].c[1]=j+1;b.chain[j].c[j&1]=-1;b.chain[j].first=b.chain[j].count=0;}
 b.chain[5].c[0]=-2;
 hitboxBounds(b);targetBounds();
}
API void set_aim(int i,float x,float y,float z){if(i>=0&&i<3)aims[i]={x,y,z};}
API void trace(float x,float y,float z,float ex,float ey,float ez,int hull){
 Trace t=worldtrace({x,y,z},{ex,ey,ez},hull==1?1:hull==3?3:0);
 scratch[0]=t.f;scratch[1]=t.end.x;scratch[2]=t.end.y;scratch[3]=t.end.z;
 scratch[4]=t.normal.x;scratch[5]=t.normal.y;scratch[6]=t.normal.z;
 scratch[7]=t.start;scratch[8]=t.all;scratch[9]=t.ent;
 scratch[10]=material(t.ent,{x,y,z},{ex,ey,ez});
}
API void fire(float x,float y,float z,float ax,float ay,float az){
 Shot s=shoot({x,y,z},{ax,ay,az});
 scratch[0]=s.raw;scratch[1]=s.group;scratch[2]=s.walls;
}
// Job: stance, origin xyz, known-placement flag, known z. Result: valid, origin
// xyz, eye z, then raw damage / hitgroup / walls for each of the three anchors.
API void sample_batch(int count){
 count=count>4096?4096:count;
 for(int i=0;i<count;i++){
  float*r=results+i*14;
  for(int j=0;j<14;j++)r[j]=0;
  int stance=int(jobs[i*6]);
  V p{jobs[i*6+1],jobs[i*6+2],jobs[i*6+3]+(stance?18:36)+2};
  if(jobs[i*6+4])p.z=jobs[i*6+5];
  else{
   int hull=stance?3:1;
   Trace t=worldtrace(p,p,hull);
   if(t.start||t.all)continue;
   t=worldtrace(p,p+V{0,0,-6},hull);
   if(t.f>=1||t.start||t.normal.z<.7f)continue;
   p=t.end;
  }
  V eye=p+V{0,0,stance?12.f:17.f};
  r[0]=1;r[1]=p.x;r[2]=p.y;r[3]=p.z;r[4]=eye.z;
  for(int a=0;a<3;a++){
   Shot s=shoot(eye,aims[a]);
   r[5+a*3]=s.raw;r[6+a*3]=s.group;r[7+a*3]=s.walls;
  }
 }
}
#ifndef __wasm__
// Native build is an independent executable for differential fixtures and
// profiling, not a runtime dependency of the web app.
//   lab-native map.bsp            stdin: 7 float32 per trace request, stdout: 11 float32
//   lab-native map.bsp scene.bin  replays a dumped scene (materials, brush
//                                 transforms, hitboxes, aims, jobs) through
//                                 sample_batch; stdout: 14 float32 per job
#include <chrono>
#include <vector>
static std::vector<uint32_t> words;static size_t cursor;
static int32_t wi(){union{uint32_t u;int32_t i;}v;v.u=words[cursor++];return v.i;}
static float wf(){union{uint32_t u;float f;}v;v.u=words[cursor++];return v.f;}
static int replay(const char*path){FILE*f=fopen(path,"rb");if(!f)return 5;uint32_t w;while(fread(&w,4,1,f)==1)words.push_back(w);fclose(f);
 int textures=wi();for(int i=0;i<textures;i++)set_material(i,wi());
 int sets=wi();for(int i=0;i<sets;i++){int id=wi(),solid=wi();float v[6];for(float&x:v)x=wf();set_brush(id,solid,v[0],v[1],v[2],v[3],v[4],v[5]);}
 int boxes=wi();for(int i=0;i<boxes;i++){int group=wi();float expansion=wf();for(int j=0;j<18;j++)scratch[j]=wf();add_hitbox(group,expansion);}
 for(int i=0;i<3;i++){float x=wf(),y=wf(),z=wf();set_aim(i,x,y,z);}
 int count=wi();std::vector<float> all(count*6),out(count*14);for(float&x:all)x=wf();
 auto started=std::chrono::steady_clock::now();
 for(int at=0;at<count;at+=4096){int n=count-at<4096?count-at:4096;for(int i=0;i<n*6;i++)jobs[i]=all[at*6+i];sample_batch(n);for(int i=0;i<n*14;i++)out[at*14+i]=results[i];}
 double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
 fprintf(stderr,"%d samples in %.1f ms (%.3f us/sample)\n",count,ms,ms*1000/count);
 fwrite(out.data(),sizeof(float),out.size(),stdout);return 0;}
int main(int argc,char**argv){
#ifdef _WIN32
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#endif
 if(argc<2||argc>3)return 2;FILE*f=fopen(argv[1],"rb");if(!f)return 3;uint8_t*map=(uint8_t*)map_ptr(MAX_MAP);int n=fread(map,1,MAX_MAP,f);fclose(f);if(!map_load(n))return 4;
 if(argc==3)return replay(argv[2]);
 float q[7];while(fread(q,sizeof(float),7,stdin)==7){trace(q[0],q[1],q[2],q[3],q[4],q[5],int(q[6]));fwrite(scratch,sizeof(float),11,stdout);}return 0;}
#endif
