# 치수 교차 확인용: ezdxf(MIT)로 치수를 만들고 ezdxf 자체 렌더러로 블록을 그려 DXF로 쓴다(결과만 비교한다)
import sys, math
import ezdxf
doc = ezdxf.new('R2018', setup=True)
msp = doc.modelspace()
ds = doc.dimstyles.get('EZDXF')
def dimstyle(name, **kw):
    s = doc.dimstyles.duplicate_entry('EZDXF', name)
    for k, v in kw.items():
        s.set_dxf_attrib(k, v)
    return name
base = dict(dimasz=2.5, dimexo=0.625, dimexe=1.25, dimgap=0.625, dimtxt=2.5, dimtad=1, dimtih=0, dimtoh=0, dimdec=2, dimzin=8, dimtofl=1, dimcen=2.5, dimblk='', dimblk1='', dimblk2='', dimsah=0, dimlunit=2, dimscale=1, dimtsz=0, dimdle=0, dimtix=0, dimsoxd=0, dimatfit=3, dimjust=0, dimadec=0, dimdsep=46, dimpost='', dimtmove=0)
dimstyle('ISO', **base)
dimstyle('TAD0', **{**base, 'dimtad': 0, 'dimtih': 1, 'dimtoh': 1})
dimstyle('TICK', **{**base, 'dimblk': 'ARCHTICK', 'dimdle': 1.5})
dimstyle('NOTOFL', **{**base, 'dimtofl': 0})
cases = []
def lin(style, p1, p2, base_, angle=0):
    d = msp.add_linear_dim(base=base_, p1=p1, p2=p2, angle=angle, dimstyle=style); d.render(); cases.append(d.dimension)
def ali(style, p1, p2, dist):
    d = msp.add_aligned_dim(p1=p1, p2=p2, distance=dist, dimstyle=style); d.render(); cases.append(d.dimension)
for st in ['ISO', 'TAD0', 'TICK']:
    lin(st, (0, 0), (100, 0), (50, 20))
    lin(st, (0, 100), (60, 130), (-20, 120), 90)
    lin(st, (200, 0), (260, 40), (220, 80), 30)
    ali(st, (300, 0), (330, 40), 15)
    ali(st, (400, 0), (360, 30), -10)
for st in ['ISO', 'TAD0']:
    d = msp.add_angular_dim_3p(base=(530, 30), center=(500, 0), p1=(550, 0), p2=(500, 50), dimstyle=st); d.render(); cases.append(d.dimension)
    d = msp.add_angular_dim_2l(base=(610, 20), line1=((600, 0), (650, 0)), line2=((600, 0), (570, 40)), dimstyle=st); d.render(); cases.append(d.dimension)
    d = msp.add_angular_dim_3p(base=(760, 10), center=(700, 0), p1=(800, 0), p2=(780, 60), dimstyle=st); d.render(); cases.append(d.dimension)
for st in ['ISO', 'NOTOFL', 'TAD0']:
    d = msp.add_radius_dim(center=(900, 0), radius=20, angle=45, dimstyle=st); d.render(); cases.append(d.dimension)
    d = msp.add_radius_dim(center=(1000, 0), radius=20, angle=150, dimstyle=st); d.render(); cases.append(d.dimension)
    d = msp.add_diameter_dim(center=(1100, 0), radius=20, angle=30, dimstyle=st); d.render(); cases.append(d.dimension)
for st in ['ISO']:
    d = msp.add_ordinate_x_dim(feature_location=(1210, 5), offset=(5, 35), origin=(1200, 0), dimstyle=st); d.render(); cases.append(d.dimension)
    d = msp.add_ordinate_y_dim(feature_location=(1310, 5), offset=(30, 0), origin=(1300, 0), dimstyle=st); d.render(); cases.append(d.dimension)
    d = msp.add_ordinate_y_dim(feature_location=(1410, 5), offset=(30, 8), origin=(1400, 0), dimstyle=st); d.render(); cases.append(d.dimension)
doc.saveas(sys.argv[1])
print(len(cases))
