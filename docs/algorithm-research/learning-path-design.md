# 闯关学习路径的设计依据

2026-11-11，采用 B3「当前阶段＋阶段总览弹窗」；知识树继续作为完整查阅入口，学习路径按做题能力先广后深组织，不将知识树的每个节点直接排成必修清单。

## 练习与反馈

参考 [Carnegie Mellon University：Learning Principles](https://www.cmu.edu/teaching/principles/learning.html) 中的知识组织、分技能与综合应用、目标导向练习、及时反馈和自我监控原则：

- 每关使用明确算法或方法名称，列出适用条件、先修、学习目标及实际知识树关联。
- 交错学习不同专题，每章安排混合练习和综合挑战；已学算法在后续题组中再次出现。
- 反馈说明完成了什么：首关、综合关、章节和复盘记录形成里程碑，不根据勾选授予 CF 水平。
- 已完成、当前、未开始用颜色、文字与图标共同区分；减少动画偏好下取消庆祝动画。
- 允许跳学与回补；高阶专题按需求选修，不以全清知识点作为达到某个题目分数的保证。
- 队员互助围绕真实相关笔记贡献者、算法说明和可复制的互助卡展开；没有后台活动数据时不展示虚构队员动态。

这组原则为设计参考，不代表单一界面设计已经被证实能提升竞赛成绩。

## 难度体系

- [Codeforces：Problem Difficulties](https://codeforces.com/blog/entry/62865)：题目 Rating 用于细分训练选题窗口，不等同选手 Rating。
- [洛谷：题目难度体系](https://help.luogu.com.cn/manual/luogu/problem/difficulty)：洛谷难度为独立分级，主观且可能调整，按标签提供另一组选题参考。
- 知识树 D1–D5 按算法的具体学习范围评价，直接读取节点数据，不换算成 CF 或洛谷等级。
- 学习路径目前绑定实际算法节点，题单后续按题目核实；未提供虚构题号或自动评测结果。

## 数据与维护

路线源数据是 [algorithm-learning-path.json](../../data/algorithm-learning-path.json)，构建入口是 [build-algorithm-learning-path.cjs](../../tools/build-algorithm-learning-path.cjs)。生成器验证节点、先修、关卡及难度数据后生成客户端运行资源。进度由用户在当前设备按账号和资料库保存；知识树与路线可以双向进入关联内容。
