// Exact-f64 CS2 numeric scan kernel. No fast math or contracted multiply-adds.
// Ray/triangle and SAT arithmetic follow Three 0.170 and three-mesh-bvh 0.9.8
// (MIT; existing web/public/licenses). Interval/damage rules follow cs2/collision.ts.
#include <stdint.h>
#define API extern "C" __attribute__((visibility("default")))
extern "C" __attribute__((import_module("math"), import_name("pow"))) double host_pow(double, double);
extern "C" unsigned char __heap_base;
extern "C" void* memcpy(void* dst, const void* src, unsigned long n) {
  auto d=(unsigned char*)dst; auto s=(const unsigned char*)src; for(unsigned long i=0;i<n;i++)d[i]=s[i];return dst;
}
extern "C" void* memset(void* dst, int v, unsigned long n) {
  auto d=(unsigned char*)dst; for(unsigned long i=0;i<n;i++)d[i]=(unsigned char)v;return dst;
}
struct V { double x,y,z; };
static V add(V a,V b){return {a.x+b.x,a.y+b.y,a.z+b.z};}
static V sub(V a,V b){return {a.x-b.x,a.y-b.y,a.z-b.z};}
static V mul(V a,double b){return {a.x*b,a.y*b,a.z*b};}
static V cross(V a,V b){return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x};}
static double dot(V a,V b){return a.x*b.x+a.y*b.y+a.z*b.z;}
static double length(V a){return __builtin_sqrt(dot(a,a));}
static double absd(double x){return __builtin_fabs(x);}
static double mn(double a,double b){if(a!=a||b!=b)return __builtin_nan("");if(a==b&&a==0)return __builtin_signbit(a)?a:b;return a<b?a:b;}
static double mx(double a,double b){if(a!=a||b!=b)return __builtin_nan("");if(a==b&&a==0)return __builtin_signbit(a)?b:a;return a>b?a:b;}
static double mn3(double a,double b,double c){return mn(mn(a,b),c);}
static double mx3(double a,double b,double c){return mx(mx(a,b),c);}
struct Box {V lo,hi;};
struct Root {uint32_t ptr,count;};
struct Node {float bounds[6];uint32_t index,flags;};
static_assert(sizeof(Node)==32);
struct Shape {uint32_t kind,flags,first,count;};
struct Material {double modifier,block;};
struct Pair {double modifier,fraction;};
struct Map {
  uint32_t positions,indices,materials,shapes,indirect,roots,rootCount,shapeInfo,planes,materialInfo,pairs,shapeCount,materialCount,ranks;
  double far,bounds[6],weapon[4];
};
static_assert(__builtin_offsetof(Map,far)==56);
static_assert(sizeof(Map)==144);
struct Hit {double distance,facing,z;uint32_t material,shape;int next;uint32_t rank;};
struct Span {double enter,exit;uint32_t material,exitMaterial,shape,inside;};
constexpr int H=4096, S=4096, M=8192, SH=16384, O=512, J=1024;
struct Context {
  Hit hits[H],temp[H],sort[H];
  Span spans[S],merged[M];
  double points[M],levels[O],seen[2][O],origins[O*4];
  uint32_t stamp[SH],ids[SH];int heads[SH],tails[SH];
  double jobs[J*6],results[J*3],metrics[8],weapon[4];
  int error,nh,ns,nm,nids,nlevels,norigins,floors,rejected,seenCount[2];
  uint32_t generation;
  V source,direction;double distance;
};
template<class T> static T* ptr(uint32_t p){return (T*)(uintptr_t)p;}
static V vertex(Map* m,uint32_t index){float* p=ptr<float>(m->positions)+index*3;return {p[0],p[1],p[2]};}
static void triangle(Map* m,uint32_t t,V& a,V& b,V& c){auto i=ptr<uint32_t>(m->indices)+t*3;a=vertex(m,i[0]);b=vertex(m,i[1]);c=vertex(m,i[2]);}
static bool raybox(const float* a,uint32_t n,V o,V inv,double near,double far){
  double low=(a[n+(inv.x>=0?0:3)]-o.x)*inv.x, high=(a[n+(inv.x>=0?3:0)]-o.x)*inv.x;
  double yl=(a[n+(inv.y>=0?1:4)]-o.y)*inv.y, yh=(a[n+(inv.y>=0?4:1)]-o.y)*inv.y;
  if(low>yh||yl>high)return false;
  if(yl>low||low!=low)low=yl;if(yh<high||high!=high)high=yh;
  double zl=(a[n+(inv.z>=0?2:5)]-o.z)*inv.z, zh=(a[n+(inv.z>=0?5:2)]-o.z)*inv.z;
  if(low>zh||zl>high)return false;
  if(zl>low||low!=low)low=zl;if(zh<high||high!=high)high=zh;
  return low<=far&&high>=near;
}
static bool raytriangle(Map* m,Context*,uint32_t t,V o,V d,V& point,V& normal){
  V a,b,c;triangle(m,t,a,b,c);V e1=sub(b,a),e2=sub(c,a),n=cross(e1,e2);double ddn=dot(d,n),sign;
  if(ddn>0)sign=1;else if(ddn<0){sign=-1;ddn=-ddn;}else return false;
  V diff=sub(o,a);double dqe=sign*dot(d,cross(diff,e2));if(dqe<0)return false;
  double deq=sign*dot(d,cross(e1,diff));if(deq<0||dqe+deq>ddn)return false;
  double qdn=-sign*dot(diff,n);if(qdn<0)return false;
  point=add(o,mul(d,qdn/ddn));normal=cross(sub(c,b),sub(a,b));double sq=dot(normal,normal);
  normal=sq>0?mul(normal,1/__builtin_sqrt(sq)):V{0,0,0};return true;
}
static void collect(Map* m,Context* q,V origin,V direction,uint32_t kind,double far){
  q->nh=0;q->metrics[0]++;V inv={1/direction.x,1/direction.y,1/direction.z};
  auto shapes=ptr<uint32_t>(m->shapes);auto materials=ptr<uint32_t>(m->materials);auto indirect=ptr<uint32_t>(m->indirect);auto info=ptr<Shape>(m->shapeInfo);
  Root* roots=ptr<Root>(m->roots);
  for(uint32_t r=0;r<m->rootCount;r++){
    Node* nodes=ptr<Node>(roots[r].ptr);uint32_t node=0;
    while(node<roots[r].count){
      const Node& n=nodes[node];
      if(node){q->metrics[1]++;if(!(n.flags&kind)||!raybox(n.bounds,0,origin,inv,.001,far)){node=(n.flags&8)?node+1:n.index;continue;}}
      if(n.flags&8)for(uint32_t i=n.index;i<n.index+(n.flags>>8);i++){
        uint32_t t=indirect[i],shape=shapes[t];if(!(info[shape].flags&kind))continue;
        q->metrics[2]++;V point,normal;if(!raytriangle(m,q,t,origin,direction,point,normal))continue;
        double distance=length(sub(origin,point));if(distance<.001||distance>far)continue;
        if(q->nh==H){q->error=1;return;}
        q->hits[q->nh++]={distance,dot(normal,direction),point.z,materials[t],shape,-1,m->ranks?ptr<uint32_t>(m->ranks)[t]:0};
      }
      node++;
    }
  }
  if(m->ranks)for(int i=1;i<q->nh;i++){Hit hit=q->hits[i];int j=i;for(;j>0&&q->hits[j-1].rank>hit.rank;j--)q->hits[j]=q->hits[j-1];q->hits[j]=hit;}
  q->metrics[6]+=q->nh;
}
// Stable numeric merge sort. Equality always keeps the original DFS crossing first.
static void sortHits(Hit* a,Hit* work,int n){
  for(int width=1;width<n;width*=2){
    for(int start=0;start<n;start+=width*2){int mid=start+width<n?start+width:n,end=start+width*2<n?start+width*2:n,i=start,j=mid,k=start;
      while(i<mid&&j<end)work[k++]=a[i].distance<=a[j].distance?a[i++]:a[j++];
      while(i<mid)work[k++]=a[i++];while(j<end)work[k++]=a[j++];
    }for(int i=0;i<n;i++)a[i]=work[i];
  }
}
static void pushSpan(Context* q,double enter,double exit,uint32_t material,uint32_t out,uint32_t shape,bool inside){
  if(q->ns==S){q->error=1;return;}q->spans[q->ns++]={enter,exit,material,out,shape,(uint32_t)inside};
}
static void mesh(Map*,Context* q,int count,uint32_t shape,double distance){
  sortHits(q->temp,q->sort,count);int unique=0;
  for(int i=0;i<count;i++){
    Hit h=q->temp[i];if(unique&&absd(q->temp[unique-1].distance-h.distance)<.01){
      if(q->temp[unique-1].distance<=distance&&q->temp[unique-1].facing*h.facing<0)q->nids=-1;
    }else q->temp[unique++]=h;
  }
  bool inside=unique&&q->temp[0].facing>0,has=inside;Hit entry={0,-1,0,unique?q->temp[0].material:0,shape,-1};
  for(int i=0;i<unique;i++){
    Hit h=q->temp[i];if(h.distance>distance&&!has)break;
    if(h.facing<0){if(has)q->nids=-1;else{entry=h;has=true;}}
    else if(has){if(entry.distance<distance&&h.distance-entry.distance>.01)pushSpan(q,entry.distance,h.distance,entry.material,h.material,shape,inside);has=false;inside=false;}
    else if(h.distance<distance)q->nids=-1;
    if(h.distance>distance&&!has)break;
  }
  if(has&&entry.distance<distance)q->nids=-1;
}
static bool hull(Map* m,Shape shape,V o,V d,double length,double& enter,double& exit){
  enter=0;exit=__builtin_inf();double* planes=ptr<double>(m->planes)+shape.first*4;
  for(uint32_t i=0;i<shape.count;i++){
    double* p=planes+i*4;double distance=p[3]-(p[0]*o.x+p[1]*o.y+p[2]*o.z),velocity=p[0]*d.x+p[1]*d.y+p[2]*d.z;
    if(absd(velocity)<1e-10){if(distance<-1e-5)return false;}
    else if(velocity<0)enter=mx(enter,distance/velocity);else exit=mn(exit,distance/velocity);
    if(enter>exit+1e-5)return false;
  }return enter<length&&exit-enter>.01&&exit>.01;
}
static void unionSpans(Map* m,Context* q){
  q->nm=0;if(!q->ns)return;
  if(q->ns==1){if(q->spans[0].exit-q->spans[0].enter>=.01)q->merged[q->nm++]=q->spans[0];return;}
  int n=0;for(int i=0;i<q->ns;i++){q->points[n++]=q->spans[i].enter;q->points[n++]=q->spans[i].exit;}
  // Shell sort only sorts endpoint values; the original Set's equality is IEEE == here.
  for(int gap=n/2;gap;gap/=2)for(int i=gap;i<n;i++){double v=q->points[i];int j=i;for(;j>=gap&&q->points[j-gap]>v;j-=gap)q->points[j]=q->points[j-gap];q->points[j]=v;}
  int u=0;for(int i=0;i<n;i++)if(!u||q->points[i]!=q->points[u-1])q->points[u++]=q->points[i];
  Material* materials=ptr<Material>(m->materialInfo);
  for(int i=0;i<u-1;i++){
    double a=q->points[i],b=q->points[i+1];if(b-a<.01)continue;int winner=-1;double modifier=__builtin_inf();
    for(int j=0;j<q->ns;j++){Span s=q->spans[j];if(s.enter>a+1e-6||s.exit<b-1e-6)continue;double candidate=materials[s.material].modifier;if(winner<0||candidate<modifier){winner=j;modifier=candidate;}}
    if(winner<0)continue;Span s=q->spans[winner];
    if(q->nm&&q->merged[q->nm-1].shape==s.shape&&q->merged[q->nm-1].material==s.material&&absd(q->merged[q->nm-1].exit-a)<.01)q->merged[q->nm-1].exit=b;
    else{if(q->nm==M){q->error=1;return;}s.enter=a;s.exit=b;q->merged[q->nm++]=s;}
  }
}
struct Energy {double damage,status,walls;};
static Energy intervals(Map* m,Context* q,V o,V d,double distance,bool energy){
  q->ns=0;q->nids=0;if(++q->generation==0){for(int i=0;i<SH;i++)q->stamp[i]=0;q->generation=1;}
  for(int i=0;i<q->nh;i++){
    uint32_t shape=q->hits[i].shape;if(q->stamp[shape]!=q->generation){q->stamp[shape]=q->generation;q->ids[q->nids++]=shape;q->heads[shape]=q->tails[shape]=i;}
    else{q->hits[q->tails[shape]].next=i;q->tails[shape]=i;}
  }
  bool sky=false,issues=false;int groups=q->nids;Shape* shapes=ptr<Shape>(m->shapeInfo);
  for(int g=0;g<groups;g++){
    uint32_t id=q->ids[g];Shape shape=shapes[id];int head=q->heads[id];
    if(shape.flags&4){for(int i=head;i>=0;i=q->hits[i].next)if(q->hits[i].distance<=distance)sky=true;continue;}
    if(shape.kind){double enter,exit;if(hull(m,shape,o,d,distance,enter,exit))pushSpan(q,enter,exit,q->hits[head].material,q->hits[head].material,id,enter<.01);}
    else{int n=0;for(int i=head;i>=0;i=q->hits[i].next)if(absd(q->hits[i].facing)>1e-6)q->temp[n++]=q->hits[i];q->nids=0;mesh(m,q,n,id,distance);issues|=q->nids<0;}
  }
  unionSpans(m,q);if(!energy){for(int i=0;i<q->nm;i++)if(q->merged[i].inside)return {1,0,(double)q->nm};return {0,0,(double)q->nm};}
  if(sky)return {0,2,(double)q->nm};if(issues)return {-1,3,(double)q->nm};
  if(distance>q->weapon[2])return {0,2,(double)q->nm};
  double damage=q->weapon[0],travelled=0;int obstacles=0;auto mat=ptr<Material>(m->materialInfo);auto pairs=ptr<Pair>(m->pairs);
  for(int i=0;i<q->nm;i++){
    Span first=q->merged[i];double exit=first.exit,modifier=0,fraction=0;bool has=false;
    for(;;){Span s=q->merged[i];if(s.inside||s.exit>=distance-.01)return {-1,3,(double)q->nm};
      if(mat[s.material].block||mat[s.exitMaterial].block||(shapes[s.shape].flags&4))return {0,2,(double)q->nm};
      Pair p=pairs[s.material*m->materialCount+s.exitMaterial];if(p.modifier<=0)return {-1,3,(double)q->nm};
      if(!has||p.modifier<modifier){modifier=p.modifier;fraction=p.fraction;has=true;}else fraction=mx(fraction,p.fraction);
      exit=mx(exit,s.exit);if(i+1>=q->nm||q->merged[i+1].enter>exit+.01)break;i++;
    }
    damage*=host_pow(q->weapon[3],(first.enter-travelled)/500);travelled=first.enter;
    if(++obstacles>4||q->weapon[1]<=0)return {0,2,(double)q->nm};
    double impact=damage*fraction+11.25/(q->weapon[1]*modifier),thickness=exit-first.enter;
    double mass=(thickness*thickness)/(24*modifier);damage=mx(0,damage-(impact+mass));
    if(damage<1)return {0,2,(double)q->nm};
  }
  damage*=host_pow(q->weapon[3],(distance-travelled)/500);return {damage,q->nm?1.:0.,(double)q->nm};
}
static Energy trace(Map* m,Context* q,V source,V target,uint32_t kind,bool energy){
  V delta=sub(target,source);double distance=length(delta);V direction=mul(delta,1/(distance?distance:1));
  collect(m,q,source,direction,kind,mx(m->far,distance+m->far));if(q->error)return {-1,-1,-1};
  return intervals(m,q,source,direction,distance,energy);
}
static bool intersects(Box a,Box b){return !(b.hi.x<a.lo.x||b.lo.x>a.hi.x||b.hi.y<a.lo.y||b.lo.y>a.hi.y||b.hi.z<a.lo.z||b.lo.z>a.hi.z);}
static bool sataxis(V axis,V v0,V v1,V v2,V extents){
  double radius=extents.x*absd(axis.x)+extents.y*absd(axis.y)+extents.z*absd(axis.z),p0=dot(v0,axis),p1=dot(v1,axis),p2=dot(v2,axis);
  return !(mx(-mx3(p0,p1,p2),mn3(p0,p1,p2))>radius);
}
static bool trianglebox(V a,V b,V c,V center,V extents){
  V v0=sub(a,center),v1=sub(b,center),v2=sub(c,center),f[3]={sub(v1,v0),sub(v2,v1),sub(v0,v2)};
  for(int i=0;i<3;i++)if(!sataxis({0,-f[i].z,f[i].y},v0,v1,v2,extents))return false;
  for(int i=0;i<3;i++)if(!sataxis({f[i].z,0,-f[i].x},v0,v1,v2,extents))return false;
  for(int i=0;i<3;i++)if(!sataxis({-f[i].y,f[i].x,0},v0,v1,v2,extents))return false;
  return sataxis({1,0,0},v0,v1,v2,extents)&&sataxis({0,1,0},v0,v1,v2,extents)&&sataxis({0,0,1},v0,v1,v2,extents)&&sataxis(cross(f[0],f[1]),v0,v1,v2,extents);
}
struct Sweep {double fraction;V normal;bool hit;};
static Sweep sweeptriangle(V a,V b,V c,V center,V half,V delta){
  V edges[3]={sub(b,a),sub(c,b),sub(a,c)},axes[13]={{1,0,0},{0,1,0},{0,0,1}};axes[3]=cross(edges[0],edges[1]);int next=4;
  for(int i=0;i<3;i++)for(int j=0;j<3;j++)axes[next++]=cross(edges[i],axes[j]);
  double enter=-__builtin_inf(),exit=__builtin_inf();V normal={0,0,0};
  for(int i=0;i<13;i++){
    V axis=axes[i];double sq=dot(axis,axis);if(sq<1e-14)continue;axis=mul(axis,1/__builtin_sqrt(sq));
    double pa=dot(a,axis),pb=dot(b,axis),pc=dot(c,axis),radius=absd(axis.x)*half.x+absd(axis.y)*half.y+absd(axis.z)*half.z;
    double low=mn3(pa,pb,pc)-radius-dot(center,axis),high=mx3(pa,pb,pc)+radius-dot(center,axis),speed=dot(delta,axis);
    if(absd(speed)<1e-10){if(low>=-1e-7||high<=1e-7)return {};continue;}
    double first=mn(low/speed,high/speed),last=mx(low/speed,high/speed);
    if(first>enter){enter=first;normal=mul(axis,speed>0?-1:1);}exit=mn(exit,last);if(enter>exit+1e-8)return {};
  }
  if(enter<-1e-7||enter>1||exit<0||!__builtin_isfinite(enter))return {};
  return {mx(0,enter),normal,true};
}
static Sweep playerquery(Map* m,Context* q,V foot,double height,V delta,bool sweep){
  Box bounds;V center,half;
  if(sweep){center={foot.x,foot.y,foot.z+height/2};half={16,16,height/2};bounds={sub(center,half),add(center,half)};
    V lo=add(bounds.lo,delta),hi=add(bounds.hi,delta);bounds.lo={mn(bounds.lo.x,lo.x)-.001,mn(bounds.lo.y,lo.y)-.001,mn(bounds.lo.z,lo.z)-.001};bounds.hi={mx(bounds.hi.x,hi.x)+.001,mx(bounds.hi.y,hi.y)+.001,mx(bounds.hi.z,hi.z)+.001};q->metrics[4]++;
  }else{bounds={{foot.x-15.99,foot.y-15.99,foot.z+.01},{foot.x+15.99,foot.y+15.99,foot.z+height-.01}};center=mul(add(bounds.lo,bounds.hi),.5);half=sub(bounds.hi,center);q->metrics[3]++;}
  Root* roots=ptr<Root>(m->roots);auto info=ptr<Shape>(m->shapeInfo);auto shapes=ptr<uint32_t>(m->shapes);auto indirect=ptr<uint32_t>(m->indirect);Sweep closest={};uint32_t closestRank=0xffffffff;
  for(uint32_t r=0;r<m->rootCount;r++){
    Node* nodes=ptr<Node>(roots[r].ptr);uint32_t node=0;
    while(node<roots[r].count){
      const Node& n=nodes[node];
      if(node&&(!(n.flags&2)||!intersects(bounds,{{n.bounds[0],n.bounds[1],n.bounds[2]},{n.bounds[3],n.bounds[4],n.bounds[5]}}))){node=(n.flags&8)?node+1:n.index;continue;}
      if(n.flags&8)for(uint32_t i=n.index;i<n.index+(n.flags>>8);i++){
        uint32_t t=indirect[i];if(!(info[shapes[t]].flags&2))continue;V a,b,c;triangle(m,t,a,b,c);
        if(sweep){Sweep hit=sweeptriangle(a,b,c,center,half,delta);uint32_t rank=m->ranks?ptr<uint32_t>(m->ranks)[t]:i;if(hit.hit&&(!closest.hit||hit.fraction<closest.fraction||(hit.fraction==closest.fraction&&rank<closestRank))){closest=hit;closestRank=rank;}}
        else if(trianglebox(a,b,c,center,half))return {0,{0,0,0},true};
      }
      node++;
    }
  }return closest;
}
static bool fits(Map* m,Context* q,V foot,double height,bool inside){
  if(playerquery(m,q,foot,height,{0,0,0},false).hit)return false;
  if(!inside)return true;V center={foot.x,foot.y,foot.z+height/2};return !trace(m,q,center,{center.x,center.y,center.z+1},2,false).damage;
}
API uint32_t cs2_heap_base(){return (uint32_t)(uintptr_t)&__heap_base;}
API uint32_t cs2_abi(){return 1;}
API uint32_t cs2_context_size(){return sizeof(Context);}
API uint32_t cs2_origins_ptr(uint32_t p){return (uint32_t)(uintptr_t)ptr<Context>(p)->origins;}
API uint32_t cs2_jobs_ptr(uint32_t p){return (uint32_t)(uintptr_t)ptr<Context>(p)->jobs;}
API uint32_t cs2_results_ptr(uint32_t p){return (uint32_t)(uintptr_t)ptr<Context>(p)->results;}
API uint32_t cs2_metrics_ptr(uint32_t p){return (uint32_t)(uintptr_t)ptr<Context>(p)->metrics;}
API uint32_t cs2_weapon_ptr(uint32_t p){return (uint32_t)(uintptr_t)ptr<Context>(p)->weapon;}
API int cs2_floors(uint32_t p){return ptr<Context>(p)->floors;}
API int cs2_rejected(uint32_t p){return ptr<Context>(p)->rejected;}
// Diagnostic parity entry points also exercise tied axis/triangle normal ordering.
API int cs2_sweep(uint32_t mp,uint32_t cp,double x,double y,double z,double h,double dx,double dy,double dz){
  Context* q=ptr<Context>(cp);Sweep s=playerquery(ptr<Map>(mp),q,{x,y,z},h,{dx,dy,dz},true);
  q->results[0]=s.fraction;q->results[1]=s.normal.x;q->results[2]=s.normal.y;q->results[3]=s.normal.z;return s.hit;
}
API int cs2_fits(uint32_t mp,uint32_t cp,double x,double y,double z,double h,int inside){
  Context* q=ptr<Context>(cp);q->error=0;bool result=fits(ptr<Map>(mp),q,{x,y,z},h,inside);return q->error?-1:result;
}
API int cs2_column(uint32_t mp,uint32_t cp,double x,double y){
  Map* m=ptr<Map>(mp);Context* q=ptr<Context>(cp);q->error=0;q->norigins=q->floors=q->rejected=0;q->seenCount[0]=q->seenCount[1]=0;
  if(x<m->bounds[0]||x>m->bounds[3]||y<m->bounds[1]||y>m->bounds[4])return 0;
  q->metrics[5]++;collect(m,q,{x,y,m->bounds[5]+1},{0,0,-1},2,m->far);if(q->error)return -1;sortHits(q->hits,q->sort,q->nh);q->nlevels=0;auto shapes=ptr<Shape>(m->shapeInfo);
  for(int i=0;i<q->nh;i++){Hit h=q->hits[i];if(-h.facing<.7||(shapes[h.shape].flags&4))continue;bool duplicate=false;for(int j=0;j<q->nlevels;j++)if(absd(q->levels[j]-h.z)<.1){duplicate=true;break;}
    if(!duplicate){if(q->nlevels==O)return -1;q->levels[q->nlevels++]=h.z;}}
  q->floors=q->nlevels;double lifts[5]={.05,2,4,8,18};
  for(int level=0;level<q->nlevels;level++)for(int stance=0;stance<2;stance++){
    double z=q->levels[level],height=stance?54:72;V foot={};bool placed=false;
    for(int lift=0;lift<5;lift++){double l=lifts[lift];V start={x,y,z+l};if(!fits(m,q,start,height,false))continue;
      Sweep hit=playerquery(m,q,start,height,{0,0,-(l+18)},true);if(!hit.hit||hit.normal.z<.7)break;
      foot={x,y,start.z-(l+18)*hit.fraction+.025};if(fits(m,q,foot,height,true)){placed=true;break;}
    }
    if(q->error)return -1;if(!placed){q->rejected++;continue;}bool duplicate=false;for(int i=0;i<q->seenCount[stance];i++)if(absd(q->seen[stance][i]-foot.z)<1){duplicate=true;break;}
    if(duplicate)continue;if(q->norigins==O)return -1;q->seen[stance][q->seenCount[stance]++]=foot.z;int at=q->norigins++*4;q->origins[at]=stance;q->origins[at+1]=x;q->origins[at+2]=y;q->origins[at+3]=foot.z;
  }return q->norigins;
}
API int cs2_energy_batch(uint32_t mp,uint32_t cp,int count){
  if(count<0||count>J)return -1;Map* m=ptr<Map>(mp);Context* q=ptr<Context>(cp);
  for(int i=0;i<count;i++){double* j=q->jobs+i*6;q->error=0;Energy e=trace(m,q,{j[0],j[1],j[2]},{j[3],j[4],j[5]},1,true);q->results[i*3]=e.damage;q->results[i*3+1]=q->error?-1:e.status;q->results[i*3+2]=e.walls;}
  return count;
}
API int cs2_trace_one(uint32_t mp,uint32_t cp,uint32_t kind){
  Map* m=ptr<Map>(mp);Context* q=ptr<Context>(cp);double* j=q->jobs;q->error=0;
  Energy e=trace(m,q,{j[0],j[1],j[2]},{j[3],j[4],j[5]},kind,true);
  q->results[0]=e.damage;q->results[1]=q->error?-1:e.status;q->results[2]=e.walls;return q->error?-1:0;
}
