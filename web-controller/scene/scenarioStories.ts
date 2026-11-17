import type { IdFactory } from "./ids";
import { PALETTE, cells, createScenarioStoryBuilder, type Point } from "./scenarioStoryBuilder";
import type { SceneMap } from "./types";

// The upstream stories use a ratio grid; these layouts and routes are rebuilt in mm for 60mm-radius robots.
export function populateScenarioStory(map: SceneMap, id: string, makeId: IdFactory): void {
  const { plan, region, note, zone, route, robot, human, travel, wait, doorTrack, building, finish } =
    createScenarioStoryBuilder(map, id, makeId);

  let end = 60;
  if (id === "tutorial-passage" || id === "tutorial-door") {
    const hall = region("優先通路・両端待避場所", "corridor",
      Array.from(new Set([...cells(0, 180, 1100, 440), ...cells(0, 0, 300, 620), ...cells(800, 0, 1100, 620)])), "#b8c5c7");
    let doorId: string | undefined;
    if (id === "tutorial-door") {
      const wall = { id: makeId(), roomId: hall.id, x1: 550, y1: 180, x2: 550, y2: 440 };
      doorId = makeId();
      plan.walls = [wall];
      plan.doors.push({ ...wall, id: doorId, wallId: wall.id, kind: "automatic", name: "セキュリティ扉" });
    }
    const a = robot("security", 160, 310, "A · 優先通行");
    const b = robot("cleaning", 940, 310, "B · 待機して通行");
    const approach = Math.max(travel(a, 0, [[450, 310]], "管理なし · 対向接近"),
      travel(b, 0, [[650, 310]], "管理なし · 対向接近"));
    note(0, approach, "比較1：群管理なし · 両側から接近（衝突はさせない模擬デモ）", "#ffcb81");
    note(approach, 10, "群管理なし：中央で両にらみ。互いの進路を譲れず停止", "#ff817b");
    route(approach, 10, "対向する進路", "#ff817b", [[450, 310], [650, 310], [450, 310]]);
    const pocket = travel(b, 10, [[940, 310], [940, 520]], "Bは入口の待機場所へ");
    note(10, pocket, "比較2：群管理あり · Aを優先、Bは通路入口で待機", PALETTE.cleaning);
    const aCross = travel(a, pocket + 1, [[940, 310]], "Aが優先通行");
    const aClear = travel(a, aCross, [[940, 100]], "Aが出口を空ける");
    const bReturn = travel(b, aClear + 4, [[940, 310]], "Bの通行許可");
    const bCross = travel(b, bReturn, [[160, 310]], "Bが通行");
    end = bCross + 4;
    zone("zone", 10, end, "B WAIT", PALETTE.cleaning, 820, 430, 200, 170);
    zone("zone", 10, end, "A CLEAR", PALETTE.security, 820, 20, 200, 170);
    if (doorId) {
      zone("zone", 0, end, "IN", PALETTE.security, 440, 210, 70, 70);
      zone("zone", 0, end, "OUT", PALETTE.cleaning, 590, 210, 70, 70);
      doorTrack(hall, [[0, 10], [pocket, aClear + .8], [bReturn, end]], doorId);
      note(pocket, aClear, "扉連携：Aの通過を許可", PALETTE.security);
      note(aClear + 1, bReturn, "A通過完了 → 一度閉扉 → Bのため再開扉", "#ffcb81");
      note(bReturn, end, "B通過後に施錠 · IN / OUTを順番に通行", PALETTE.cleaning);
    } else {
      note(pocket, aClear, "優先エリア使用中：A通行 / B待機", PALETTE.security);
      note(aClear, end, "Aの通過完了を建物へ通知 → Bが通行", PALETTE.cleaning);
    }
  } else {
    building();
    const loop: Point[] = [[360, 100], [980, 100], [980, 520], [360, 520], [360, 310]];
    if (id.startsWith("daily-")) {
      const security = robot("security", 160, 100);
      const cleaner = robot("cleaning", 160, 520);
      const delivery = robot("delivery", id === "daily-delivery" ? 980 : 760, 310);
      route(0, 8, "警備：夜間巡回予定", PALETTE.security, [[160, 100], ...loop]);
      route(0, 8, "清掃：夜間清掃予定", PALETTE.cleaning, [[160, 520], [160, 310], [360, 310], ...loop.slice(0, 4)]);
      route(0, 8, "配送：受取→EV予定", PALETTE.delivery,
        [[980, 310], [980, 100], [360, 100], [360, 310], [160, 310], [360, 310], [360, 100], [760, 100], [760, 310]]);
      if (id === "daily-security") {
        wait(security, 0, 8, "昼 · エントランス充電待機");
        end = travel(security, 8, [[160, 310], [360, 310], [360, 100], [980, 100], [980, 520],
          [360, 520], [360, 310], [160, 310], [160, 100]], "夜間巡回") + 4;
        note(0, 8, "昼：3台はそれぞれ待機 · 夜間へ時間を圧縮して切替");
        note(8, end, "夜：警備が廊下を一周 / 清掃・配送は待機", PALETTE.security);
      } else if (id === "daily-cleaning") {
        wait(cleaner, 0, 8, "昼 · 充電待機");
        const start = travel(cleaner, 8, [[160, 310]], "エントランス清掃");
        zone("dirt", 8, start + 4, "夜間清掃対象 · エントランスの一部", "#bc8b52", 70, 220, 180, 180);
        wait(cleaner, start, 4, "エントランス清掃中");
        end = travel(cleaner, start + 4, [[360, 310], [360, 100], [980, 100], [980, 520],
          [360, 520], [360, 310], [160, 310], [160, 520]], "廊下清掃") + 4;
        route(start + 4, end, "廊下清掃ルート", PALETTE.cleaning, loop);
        note(0, 8, "昼：清掃ロボットは充電場所で待機");
        note(8, end, "夜：エントランスから廊下へ · 汚れ領域を清掃", PALETTE.cleaning);
      } else {
        const pickup = travel(delivery, 3, [[980, 100], [360, 100], [360, 310], [160, 310]], "セキュリティ扉を通り荷物受取");
        wait(delivery, pickup, 4, "昼 · エントランスで荷物受取");
        const call = travel(delivery, pickup + 4, [[360, 310], [360, 100], [760, 100]], "セキュリティ扉を通りEV呼出場所へ");
        wait(delivery, call, 4, "EVを目的階へ呼出・待機");
        end = travel(delivery, call + 4, [[760, 310]], "EV乗車") + 5;
        note(0, pickup, "昼：室内充電場所→セキュリティ扉→エントランス", PALETTE.delivery);
        zone("zone", pickup, pickup + 4, "荷物受取", PALETTE.delivery, 70, 220, 180, 180);
        note(call, call + 4, "建物連携：EVを目的階へ呼出（模擬）→到着待ち", PALETTE.delivery);
        note(call + 4, end, "EVへ乗車 · 他フロア移動は到着表示で表現（実EV制御なし）", PALETTE.delivery);
      }
    } else if (id === "tutorial-fire" || id === "bcp") {
      const security = robot("security", 980, 100);
      const cleaner = robot("cleaning", 360, 520);
      let alarm = 5;
      if (id === "tutorial-fire") {
        alarm = Math.max(travel(security, 0, [[980, 520]], "反時計回り巡回"),
          travel(cleaner, 0, [[360, 310]], "反時計回り巡回"));
      }
      const retreat = travel(cleaner, alarm + 1, [[360, 310], [160, 310], [160, 520]], "避難者を妨げない場所へ退避");
      const arrive = travel(security, alarm + 1, [[980, 520], [360, 520]], "異常エリアへ直行");
      if (id === "bcp") {
        const delivery = robot("delivery", 760, 310);
        travel(delivery, alarm + 1, [[760, 100]], "配送専用待機スペースへ");
      }
      end = Math.max(retreat, arrive) + 10;
      zone("fire", alarm, end, "異常・火災エリア", "#ff675e", 440, 420, 220, 180);
      zone("zone", alarm, end, "清掃 待機・退避", PALETTE.cleaning, 70, 430, 180, 180);
      if (id === "bcp") zone("zone", alarm, end, "配送 待機", PALETTE.delivery, 670, 20, 180, 170);
      note(0, alarm, "通常巡回 · 火災の発生を待つ", PALETTE.security);
      note(alarm, arrive, "建物が異常を通知 → 警備は現場へ / 他ロボットは退避", "#ff817b");
      note(arrive, end, "警備：停止して避難誘導モード / 清掃・配送：待機維持", PALETTE.security);
    } else if (id === "tutorial-crowd") {
      const delivery = robot("delivery", 980, 100);
      route(0, 6, "変更前：左回り（反時計回り）", "#ffcb81", [[980, 100], [980, 520], [360, 520], [360, 310]]);
      zone("crowd", 3, 60, "建物が把握した混雑 · ロボット視野外", "#ff817b", 300, 430, 280, 180);
      zone("scan", 0, 6, "ロボットの局所視野（模式）", PALETTE.delivery, 860, 20, 220, 180);
      route(6, 60, "変更後：右回り（時計回り）", PALETTE.cleaning, [[980, 100], [360, 100], [360, 310]]);
      const arrive = travel(delivery, 7, [[360, 100], [360, 310]], "混雑を避けて右回りへ変更");
      end = arrive + 5;
      note(0, 3, "配送先への左回りルートを計画");
      note(3, 7, "建物の人流データ：ロボットから見えない先の混雑を通知", "#ff817b");
      note(7, end, "ロボットは混雑エリアへ近づかず、右回りルートで配送", PALETTE.cleaning);
    } else if (id === "tutorial-dirt" || id === "occupancy") {
      const cleaner = robot("cleaning", 160, 520);
      const people = human(550, 310);
      zone("zone", 0, 5, "会議中 · 在室4名", "#ffcb81", 440, 200, 220, 220);
      const exit = travel(people, 5, [[360, 310], [160, 310], [50, 310]], "会議終了・エントランスから退館", 76);
      zone("zone", exit, 90, "退館済・屋外", PALETTE.security, 0, 220, 70, 180);
      zone("zone", 5, exit, "退室を検知", "#ffcb81", 440, 200, 220, 220);
      const entry = travel(cleaner, exit + 2, [[160, 310], [360, 310], [550, 310]], "空室になった会議室へ");
      zone("dirt", exit, entry + 5, "利用跡・清掃対象", "#bc8b52", 460, 220, 180, 180);
      zone("zone", exit, 110, "空室 · 建物が清掃を依頼", PALETTE.cleaning, 440, 200, 220, 220);
      wait(cleaner, entry, 5, "会議室清掃");
      let finish = entry + 5;
      if (id === "tutorial-dirt") {
        finish = travel(cleaner, finish, [[360, 310], [160, 310]], "人が歩いたエントランスの一部へ");
        zone("dirt", exit, finish + 5, "歩行跡だけ清掃 · 全面ではない", "#bc8b52", 70, 220, 180, 180);
        wait(cleaner, finish, 5, "エントランスの利用跡だけ清掃");
        finish += 5;
      }
      end = travel(cleaner, finish, [[360, 310], [160, 310], [160, 520]], "清掃完了・充電場所へ") + 3;
      note(0, exit, "会議中→参加者退館 · 在室データの変化を建物が把握");
      note(exit, end, "人がいた場所だけを可視化して清掃依頼 · 全面清掃はしない", PALETTE.cleaning);
    } else if (id === "tutorial-vip") {
      const security = robot("security", 160, 100);
      const vip = human(50, 310, "VIP（架空）", 1);
      zone("car", 0, 7, "車番 DEMO · VIP判定（模擬）", "#ffcb81", 0, 220, 100, 180);
      const welcome = travel(security, 3, [[160, 310]], "玄関で歓迎表示");
      const leadStart = welcome + 2;
      const lead = travel(security, leadStart, [[360, 310], [360, 100], [760, 100]], "VIPをEVへご案内", 68);
      const clear = travel(security, lead, [[760, 310]], "EV目的階呼出・乗車口を空ける", 68);
      const follow = travel(vip, leadStart + 3, [[160, 310], [360, 310], [360, 100], [760, 100]], "警備と同行", 68);
      end = Math.max(clear, follow) + 6;
      note(0, 3, "建物カメラ：車番認識→VIP到着と判断（架空データ・模擬）", "#ffcb81");
      note(welcome, leadStart, "警備サイネージ：WELCOME / ご来館ありがとうございます", PALETTE.security);
      note(leadStart, follow, "VIPと同行 · セキュリティ扉は通行許可と接近に連動", PALETTE.security);
      note(follow, end, "建物へEV呼出要求 · VIPの目的階を指定（模擬）", PALETTE.delivery);
    } else if (id === "garbage") {
      const cleaner = robot("cleaning", 160, 520);
      const arrive = travel(cleaner, 6, [[160, 310], [360, 310]], "カメラが指定したゴミ箇所へ");
      wait(cleaner, arrive, 6, "対象ゾーンのみ清掃");
      zone("dirt", 2, arrive + 6, "カメラ検知 · ゴミ位置", "#bc8b52", 290, 240, 140, 140);
      zone("scan", 0, 3, "AI CAMERA（模擬）", PALETTE.security, 290, 240, 140, 140);
      end = travel(cleaner, arrive + 6, [[160, 310], [160, 520]], "清掃完了・帰還") + 4;
      note(2, arrive, "カメラがゴミ位置を検知 → 建物が対象座標を清掃へ通知", "#ffcb81");
      note(arrive, arrive + 6, "清掃中：対象ゾーンだけを清掃", PALETTE.cleaning);
      note(arrive + 6, end, "清掃完了を建物へ通知 · 汚れ表示を解除", PALETTE.cleaning);
    } else if (id === "learning") {
      const cleaner = robot("cleaning", 160, 520);
      const security = robot("security", 980, 100);
      const arrive = travel(cleaner, 6, [[160, 310], [360, 310]], "利用履歴から先回り清掃");
      const patrol = travel(security, 6, [[980, 520], [780, 520]], "巡回需要の高い場所へ役割切替");
      wait(cleaner, arrive, 5, "予測清掃");
      const repeat = travel(cleaner, arrive + 5, [[360, 100], [360, 310]], "高頻度ゾーンを再巡回");
      end = Math.max(patrol, repeat) + 5;
      zone("zone", 3, arrive, "蓄積データ：次の汚れを予測", "#ffcb81", 290, 240, 140, 140);
      zone("dirt", arrive, arrive + 5, "予測箇所の清掃", "#bc8b52", 290, 240, 140, 140);
      zone("zone", 6, end, "警備の重点巡回エリア", PALETTE.security, 690, 440, 170, 140);
      note(0, 6, "履歴蓄積→需要予測（説明用の模擬データ・実AI学習ではない）");
      note(6, end, "ルート変更・清掃頻度UP・警備の重点巡回へ役割配分を切替", PALETTE.cleaning);
    } else if (id === "hospitality") {
      const delivery = robot("delivery", 160, 310);
      const arrive = travel(delivery, 6, [[360, 310], [360, 100], [760, 100]], "回答に応じた案内先へ");
      end = arrive + 5;
      note(0, 3, "お客様への質問：どちらへご案内しますか？（自動再生の模擬回答）");
      note(3, 6, "回答：エレベータ · 案内先を個別にハイライト", PALETTE.delivery);
      zone("zone", 3, end, "選択された案内先：EV", PALETTE.delivery, 660, 200, 200, 220);
      route(6, end, "回答に合わせた案内ルート", PALETTE.delivery, [[160, 310], [360, 310], [360, 100], [760, 100]]);
      note(6, end, "配送ロボットが対応ゾーンへ · 回答の実入力は次段階", PALETTE.delivery);
    } else if (id === "environment") {
      const security = robot("security", 160, 100);
      let time = travel(security, 2, [[160, 310], [360, 310], [360, 100]], "環境データ収集巡回");
      const stops: [number, number, string][] = [[980, 100, "温度高め"], [980, 520, "CO2高め"], [360, 520, "快適"]];
      for (const [x, y, label] of stops) {
        time = travel(security, time, [[x, y]], "環境測定地点へ");
        zone("scan", time, time + 3, `SCAN · ${label}（模擬）`, PALETTE.security, x - 70, y - 70, 140, 140);
        note(time, time + 3, "ロボット＝動くセンサー · 環境データを建物へ通知", PALETTE.security);
        zone("zone", time + 3, time + 7, "空調：データに応じて調整", PALETTE.cleaning, x - 70, y - 70, 140, 140);
        wait(security, time, 4, "環境スキャン・空調連動");
        time += 4;
      }
      end = time + 4;
      note(0, 2, "警備巡回と環境計測 · 実センサー・空調へは接続しない");
    } else if (id === "remote") {
      const delivery = robot("delivery", 980, 100);
      const error = travel(delivery, 0, [[980, 310]], "配送中");
      wait(delivery, error, 8, "ERROR · 遠隔就労者の対応待ち");
      zone("zone", error, error + 8, "ERROR / HELP", "#ff817b", 900, 220, 160, 180);
      note(error, error + 4, "ERROR→遠隔就労者へ通知（模擬） · ロボット停止", "#ff817b");
      note(error + 4, error + 8, "REMOTE HUD  [↑↓←→]  CONNECTED（録画風・実操作不可）", PALETTE.cleaning);
      const finish = travel(delivery, error + 8, [[980, 520], [780, 520]], "REMOTE: UP / LEFT");
      route(error + 8, finish, "遠隔操作指示：↑ 次に ←（自動再生）", PALETTE.cleaning, [[980, 310], [980, 520], [780, 520]]);
      end = finish + 5;
      note(error + 8, finish, "遠隔就労者の指示で復旧する様子を自動再生（実通信なし）", PALETTE.cleaning);
      note(finish, end, "復旧完了→自動運用へ復帰", PALETTE.delivery);
    } else {
      throw new Error(`未対応のシナリオIDです: ${id}`);
    }
  }
  finish(end);
}
