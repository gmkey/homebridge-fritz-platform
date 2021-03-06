'use strict';

const moment = require('moment');
const async = require('async');
const request = require('request');
const cheerio = require('cheerio');
const parseString = require('xml2js').parseString;

const tr = require('../lib/TR064.js');
const HomeKitTypes = require('./types.js');
const LogUtil = require('../lib/LogUtil.js');
const packageFile = require('../package.json');
const exec = require('child_process').exec;
const querystring = require('querystring');

var Accessory, Service, Characteristic, UUIDGen, PlatformAccessory, FakeGatoHistoryService;

const pluginName = 'homebridge-fritz-platform';
const platformName = 'FritzPlatform';

class Fritz_Box {
  constructor (platform, parameter, publish) {

    // HB
    PlatformAccessory = platform.api.platformAccessory;
    Accessory = platform.api.hap.Accessory;
    Service = platform.api.hap.Service;
    Characteristic = platform.api.hap.Characteristic;
    UUIDGen = platform.api.hap.uuid;
    HomeKitTypes.registerWith(platform.api.hap);
    FakeGatoHistoryService = require('fakegato-history')(platform.api);

    const self = this;
    this.platform = platform;
    this.log = platform.log;
    this.logger = new LogUtil(null, platform.log);
    this.api = platform.api;
    this.config = platform.config;
    this.types = platform.types;
    this.accessories = platform.accessories;
    this.device = platform.device;
    this.HBpath = platform.HBpath;
    this.tr = platform.tr;
    this.polling = platform.polling;
    this.error = {};
    this.client = platform.client;
    this.call = {};
    this.info = false;
    this.presenceTimer = false;
    this.randomInt = platform.randomInt;

    //Sleep function
    this.sleep = function(time) {
      return new Promise((resolve) => setTimeout(resolve, time));
    };

    this.storage = require('node-persist');
    this.storage.initSync({
      dir: self.HBpath
    });

    if(publish){
      this.addAccessory(parameter);
    } else {
      let accessory = parameter;
      accessory.context.type==this.types.repeater ? this.logTR064(parameter) : this.getService(parameter);
    }
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Add Accessories
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  addAccessory (parameter) {
    const self = this;
    let accessory;
    let name = parameter.name;
    let type = parameter.type;
    let deviceType;
    let accessoryType;

    switch(type){
      case 1:
        deviceType = Accessory.Categories.SWITCH;
        accessoryType = Service.Switch;
        break;
      case 2:
        deviceType = Accessory.Categories.SENSOR;
        parameter.accType == 'motion' ? accessoryType = Service.MotionSensor : accessoryType = Service.OccupancySensor;
        break;
      case 3:
        deviceType = Accessory.Categories.SWITCH;
        accessoryType = Service.Switch;
        break;
      case 4:
        deviceType = Accessory.Categories.SWITCH;
        accessoryType = Service.Switch;
        break;
      case 5:
        deviceType = Accessory.Categories.SENSOR;
        accessoryType = Service.ContactSensor;
        break;
      case 6:
        switch(parameter.accType){
          case 'plug':
            deviceType = Accessory.Categories.SWITCH;
            accessoryType = Service.Switch;
            break;
          case 'thermo':
            deviceType = Accessory.Categories.THERMOSTAT;
            accessoryType = Service.Thermostat;
            break;
          case 'contact':
            deviceType = Accessory.Categories.SENSOR;
            accessoryType = Service.ContactSensor;
            break;
          default:
            break;
        }
        break;
      default:
        break;
    }

    this.logger.initinfo('Publishing new accessory: ' + name);

    accessory = this.accessories[name];
    const uuid = UUIDGen.generate(name);

    accessory = new PlatformAccessory(name, uuid, deviceType);
    accessory.addService(accessoryType, name);

    // Setting reachable to true
    accessory.reachable = true;
    accessory.context = {};

    accessory.context.type = parameter.type;
    accessory.context.serialNo = parameter.serialNo;
    accessory.context.model = parameter.model;
    accessory.context.fakegato = parameter.fakegato;
    accessory.context.options = {
      host: self.config.host||'fritz.box',
      port: self.config.port||49000,
      username: self.config.username,
      password: self.config.password,
      timeout: self.platform.devOptions.timeout
    };

    switch(type){
      case 1:
        accessory.context.lastSwitchState = false;
        break;
      case 2:
        accessory.context.lastMotionState = [];
        accessory.context.lastActivation = 0;
        accessory.context.mac = parameter.mac;
        accessory.context.ip = parameter.ip;
        accessory.context.delay = parameter.delay;
        accessory.context.accType = parameter.accType;
        break;
      case 3:
        accessory.context.mac = parameter.mac;
        break;
      case 4:
        if(Object.keys(self.platform.presence).length)accessory.context.lastMotionState = false;
        accessory.context.lastSwitchState = false;
        accessory.context.disable = parameter.disable;
        accessory.context.host = parameter.host;
        accessory.context.username = parameter.username;
        accessory.context.password = parameter.password;
        accessory.context.wifi2 = parameter.wifi2;
        accessory.context.wifi5 = parameter.wifi5;
        accessory.context.wifiGuest = parameter.wifiGuest;
        accessory.context.led = parameter.led;
        accessory.context.options = {
          host: parameter.host,
          port: parameter.port||49000,
          username: parameter.username,
          password: parameter.password,
          timeout: self.platform.devOptions.timeout
        };
        break;
      case 5:
        accessory.context.lastContactSensorState = false;
        break;
      case 6:
        accessory.context.lastHASwitchState = false;
        accessory.context.ain = parameter.ain;
        accessory.context.disable = parameter.disable;
        accessory.context.accType = parameter.accType;
        accessory.context.polling = parameter.polling;
        break;
      default:
        break;
    }

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, parameter.name)
      .setCharacteristic(Characteristic.Identify, parameter.name)
      .setCharacteristic(Characteristic.Manufacturer, 'SeydX')
      .setCharacteristic(Characteristic.Model, parameter.model)
      .setCharacteristic(Characteristic.SerialNumber, parameter.serialNo)
      .setCharacteristic(Characteristic.FirmwareRevision, packageFile.version);

    //FakeGato
    if(accessory.context.fakegato){
      accessory.context.fakegato = parameter.fakegato;
      accessory.context.fakegatoType = parameter.fakegatoType; 
      accessory.context.fakegatoTimer = parameter.fakegatoTimer;
      accessory.context.fakegatoOptions = {storage:'fs',path:self.HBpath, disableTimer: accessory.context.fakegatoTimer};
      accessory.context.fakegatoService = new FakeGatoHistoryService(accessory.context.fakegatoType,accessory,accessory.context.fakegatoOptions);
      accessory.context.fakegatoService.subtype = parameter.serialNo;
      accessory.context.fakegatoService.log = self.log;
    }

    // Publish
    this.platform.api.registerPlatformAccessories(pluginName, platformName, [accessory]);

    // Cache
    this.accessories[name] = accessory;

    type != self.types.repeater ? self.getService(accessory) : self.logTR064(accessory);

  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Repeater: init tr064
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  logTR064 (accessory) {
    const self = this;
    this.tr064 = new tr.TR064(accessory.context.options, self.logger); 
    this.tr064.initDevice()
      .then(result => {
        self.logger.initinfo('Repeater initialized: ' + result.meta.friendlyName);
        result.startEncryptedCommunication()
          .then(device => {
            self.logger.initinfo('Encrypted communication started with: ' + result.meta.friendlyName); 
            self.device = device;
            self.device.login(accessory.context.options.username, accessory.context.options.password);
            self.getService(accessory);
          })
          .catch(err => {
            self.logger.errorinfo('An error occured by starting encypted communication with: ' + result.meta.friendlyName);
            self.logger.errorinfo(JSON.stringify(err,null,4));
            setTimeout(function(){
              self.logTR064(accessory);
            }, 15000);
          });
      })
      .catch(err => {
        self.logger.errorinfo('An error occured by initializing repeater: ' + accessory.displayName);
        self.logger.errorinfo(JSON.stringify(err,null,4));
        setTimeout(function(){
          self.logTR064(accessory);
        }, 15000);
      });
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Services
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  getService (accessory) {
    const self = this;
    let type = accessory.context.type;

    //Refresh AccessoryInformation
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Name, accessory.displayName)
      .setCharacteristic(Characteristic.Identify, accessory.displayName)
      .setCharacteristic(Characteristic.Manufacturer, 'SeydX')
      .setCharacteristic(Characteristic.Model, accessory.context.model)
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.serialNo)
      .setCharacteristic(Characteristic.FirmwareRevision, packageFile.version);

    accessory.on('identify', function (paired, callback) {
      self.logger.info(accessory.displayName + ': Hi!');
      callback();
    });

    let service;

    switch(type){
      case 1:
        service = accessory.getService(Service.Switch);

        if(self.platform.wifi['2.4ghz']){
          if (!service.testCharacteristic(Characteristic.WifiTwo)){
            self.logger.initinfo('Adding WIFI 2.4 Ghz Characteristic to ' + accessory.displayName);
            accessory.context.lastWifiTwoState = false;
            service.addCharacteristic(Characteristic.WifiTwo);
          }
          service.getCharacteristic(Characteristic.WifiTwo)
            .updateValue(accessory.context.lastWifiTwoState)
            .on('set', self.setWifiTwo.bind(this, accessory, service))
            .on('get', self.checkWifiTwo.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.WifiTwo)){
            self.logger.initinfo('Removing WIFI 2.4 Ghz from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.WifiTwo));
          }
        }

        if(self.platform.wifi['5ghz']){
          if(self.device.services['urn:dslforum-org:service:WLANConfiguration:3']){
            if (!service.testCharacteristic(Characteristic.WifiFive)){
              self.logger.initinfo('Adding WIFI 5 Ghz Characteristic to ' + accessory.displayName);
              accessory.context.lastWifiFiveState = false;
              service.addCharacteristic(Characteristic.WifiFive);
            }
            service.getCharacteristic(Characteristic.WifiFive)
              .updateValue(accessory.context.lastWifiFiveState)
              .on('set', self.setWifiFive.bind(this, accessory, service))
              .on('get', self.checkWifiFive.bind(this, accessory, service));
          } else {
            self.logger.warninfo(accessory.displayName + ': Can not add WIFI 5 Ghz, not supported by this device!');
          }
        } else {
          if(service.testCharacteristic(Characteristic.WifiFive)){
            self.logger.initinfo('Removing WIFI 5 Ghz from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.WifiFive));
          }
        }

        if(self.platform.wifi.guest){
          if (!service.testCharacteristic(Characteristic.WifiGuest)){
            self.logger.initinfo('Adding WIFI Guest Characteristic to ' + accessory.displayName);
            accessory.context.lastWifiGuestState = false;
            service.addCharacteristic(Characteristic.WifiGuest);
          }
          service.getCharacteristic(Characteristic.WifiGuest)
            .updateValue(accessory.context.lastWifiGuestState)
            .on('set', self.setWifiGuest.bind(this, accessory, service))
            .on('get', self.checkWifiGuest.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.WifiGuest)){
            self.logger.initinfo('Removing WIFI Guest from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.WifiGuest));
          }
        }

        if(self.platform.wifi.wps){
          if (!service.testCharacteristic(Characteristic.WifiWPS)){
            self.logger.initinfo('Adding WIFI WPS Characteristic to ' + accessory.displayName);
            accessory.context.lastWifiWPSState = false;
            service.addCharacteristic(Characteristic.WifiWPS);
          }
          service.getCharacteristic(Characteristic.WifiWPS)
            .updateValue(accessory.context.lastWifiWPSState)
            .on('set', self.setWifiWPS.bind(this, accessory, service))
            .on('get', self.checkWifiWPS.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.WifiWPS)){
            self.logger.initinfo('Removing WIFI WPS from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.WifiWPS));
          }
        }
        
        if(self.platform.wifi.refreshChannel){
          if (!service.testCharacteristic(Characteristic.RefreshChannel)){
            self.logger.initinfo('Adding Refresh Channel Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.RefreshChannel);
          }
          service.getCharacteristic(Characteristic.RefreshChannel)
            .updateValue(false)
            .on('set', self.setRefreshChannel.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.RefreshChannel)){
            self.logger.initinfo('Removing Refresh Channel from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.RefreshChannel));
          }
        }

        if(Object.keys(self.platform.reboot).length&&!self.platform.reboot.disable){
          if (!service.testCharacteristic(Characteristic.Reboot)){
            self.logger.initinfo('Adding Reboot Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.Reboot);
          }
          service.getCharacteristic(Characteristic.Reboot)
            .updateValue(false)
            .on('set', self.setReboot.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.Reboot)){
            self.logger.initinfo('Removing Reboot from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.Reboot));
          }
        }

        if(self.platform.options.answeringMachine){
          if (!service.testCharacteristic(Characteristic.AnsweringMachine)){
            self.logger.initinfo('Adding Answering Machine Characteristic to ' + accessory.displayName);
            accessory.context.lastAWState = false;
            service.addCharacteristic(Characteristic.AnsweringMachine);
          } 
          service.getCharacteristic(Characteristic.AnsweringMachine)
            .updateValue(accessory.context.lastAWState)
            .on('set', self.setAW.bind(this, accessory, service))
            .on('get', self.checkAW.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.AnsweringMachine)){
            self.logger.initinfo('Removing Answering Machine from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.AnsweringMachine));
          }
        }

        if(self.platform.options.debug){
          if (!service.testCharacteristic(Characteristic.Debug)){
            self.logger.initinfo('Adding Debug Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.Debug);
          } 
          service.getCharacteristic(Characteristic.Debug)
            .updateValue(false)
            .on('set', function(state, callback){
              if(state){
                self.device.meta.servicesInfo.forEach(function(serviceType) {
                  let service = self.device.services[serviceType];
                  console.log('---> ' + service.meta.serviceType + ' <---');
                  service.meta.actionsInfo.forEach(function(action) {
                    console.log(' # ' + action.name + '()');
                    action.inArgs.forEach(function(arg) {
                      console.log(' IN : ' + arg);
                    });
                    action.outArgs.forEach(function(arg) {
                      console.log(' OUT: ' + arg);
                    });
                  });
                });
                setTimeout(function(){service.getCharacteristic(Characteristic.Debug).updateValue(false);},500);
                callback(null, false);
              }else{
                callback(null, false);
              }
            });
        } else {
          if(service.testCharacteristic(Characteristic.Debug)){
            self.logger.initinfo('Removing Debug from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.Debug));
          }
        }

        if(self.platform.options.deflection){
          if (!service.testCharacteristic(Characteristic.Deflection)){
            self.logger.initinfo('Adding Deflection Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.Deflection);
            accessory.context.lastDeflectiontate = false;
          }
          service.getCharacteristic(Characteristic.Deflection)
            .updateValue(accessory.context.lastDeflectiontate)
            .on('set', self.setDeflection.bind(this, accessory, service))
            .on('get', self.checkDeflection.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.Deflection)){
            self.logger.initinfo('Removing Deflection from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.Deflection));
          }
        }

        if(Object.keys(self.platform.broadband).length&&!self.platform.broadband.disable){
          self.speedTest = require('speedtest-net');
          if (!service.testCharacteristic(Characteristic.DownloadSpeed)){
            self.logger.initinfo('Adding Download Speed Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.DownloadSpeed);
            accessory.context.lastDLSpeed = 0;
          }
          if (!service.testCharacteristic(Characteristic.UploadSpeed)){
            self.logger.initinfo('Adding Upload Speed Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.UploadSpeed);
            accessory.context.lastULSpeed = 0;
          }
          if (!service.testCharacteristic(Characteristic.Ping)){
            self.logger.initinfo('Adding Ping Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.Ping);
            accessory.context.lastPing = 0;
          }
          accessory.context.maxTime = self.platform.broadband.maxTime*1000||5000;
          accessory.context.broadbandPolling = self.platform.broadband.polling*60*1000||60*60*1000;
          service.getCharacteristic(Characteristic.DownloadSpeed)
            .updateValue(accessory.context.lastDLSpeed);
          service.getCharacteristic(Characteristic.UploadSpeed)
            .updateValue(accessory.context.lastULSpeed);
          service.getCharacteristic(Characteristic.Ping)
            .updateValue(accessory.context.lastPing);
          self.getMeasurement(accessory, service);
        } else {
          if(service.testCharacteristic(Characteristic.DownloadSpeed)){
            self.logger.initinfo('Removing Download Speed from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.DownloadSpeed));
          }
          if(service.testCharacteristic(Characteristic.UploadSpeed)){
            self.logger.initinfo('Removing Upload Speed from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.UploadSpeed));
          }
          if(service.testCharacteristic(Characteristic.Ping)){
            self.logger.initinfo('Removing Ping from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.Ping));
          }
        }

        if(self.platform.options.devicelock){
          if (!service.testCharacteristic(Characteristic.DeviceLock)){
            self.logger.initinfo('Adding Device Lock Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.DeviceLock);
            accessory.context.lastDeviceLock = false;
          }
          service.getCharacteristic(Characteristic.DeviceLock)
            .updateValue(accessory.context.lastDeviceLock)
            .on('set', self.setDeviceLock.bind(this, accessory, service))
            .on('get', self.checkDeviceLock.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.DeviceLock)){
            self.logger.initinfo('Removing Device Lock from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.DeviceLock));
          }
        }

        if(Object.keys(self.platform.wakeup).length){
          if(self.platform.wakeup.internNr){
            if (!service.testCharacteristic(Characteristic.WakeUp)){
              self.logger.initinfo('Adding Wake Up Characteristic to ' + accessory.displayName);
              service.addCharacteristic(Characteristic.WakeUp);
            }
            accessory.context.wakeupDuration = self.platform.wakeup.duration*1000||30000;
            accessory.context.internNr = self.platform.wakeup.internNr;
            service.getCharacteristic(Characteristic.WakeUp)
              .updateValue(false)
              .on('set', self.setWakeUp.bind(this, accessory, service));
          } else {
            if(service.testCharacteristic(Characteristic.WakeUp)){
              self.logger.initinfo('Removing Wake Up from ' + accessory.displayName);
              service.removeCharacteristic(service.getCharacteristic(Characteristic.WakeUp));
            }
          }
        } else {
          if(service.testCharacteristic(Characteristic.WakeUp)){
            self.logger.initinfo('Removing Wake Up from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.WakeUp));
          }
        }

        if(Object.keys(self.platform.alarm).length){
          if(self.platform.alarm.telNr){
            if (!service.testCharacteristic(Characteristic.DialAlarm)){
              self.logger.initinfo('Adding Alarm Characteristic to ' + accessory.displayName);
              service.addCharacteristic(Characteristic.DialAlarm);
            }
            accessory.context.alarmDuration = self.platform.alarm.duration*1000||30000;
            accessory.context.alarmNumber = self.platform.alarm.telNr;
            service.getCharacteristic(Characteristic.DialAlarm)
              .updateValue(false)
              .on('set', self.setAlarm.bind(this, accessory, service));
          } else {
            if(service.testCharacteristic(Characteristic.DialAlarm)){
              self.logger.initinfo('Removing Alarm from ' + accessory.displayName);
              service.removeCharacteristic(service.getCharacteristic(Characteristic.DialAlarm));
            }
          }
        } else {
          if(service.testCharacteristic(Characteristic.DialAlarm)){
            self.logger.initinfo('Removing Alarm from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.DialAlarm));
          }
        }

        if(self.platform.options.phoneBook){
          if (!service.testCharacteristic(Characteristic.PhoneBook)){
            self.logger.initinfo('Adding Phone Book Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.PhoneBook);
          }
          service.getCharacteristic(Characteristic.PhoneBook)
            .updateValue(false)
            .on('set', self.setPhoneBook.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.PhoneBook)){
            self.logger.initinfo('Removing Phone Book from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.PhoneBook));
          }
        }

        service.getCharacteristic(Characteristic.On)
          .updateValue(accessory.context.lastSwitchState)
          .on('get', function(callback){
            let dsl;
            self.platform.boxType == 'dsl' ? 
              dsl = self.device.services['urn:dslforum-org:service:WANPPPConnection:1'] :
              dsl = self.device.services['urn:dslforum-org:service:WANIPConnection:1'];
            if(!accessory.context.stopPolling){
              dsl.actions.GetStatusInfo(function(err, result) {
                if(!err){
                  if(result.NewConnectionStatus == 'Connected'){
                    accessory.context.lastSwitchState = true;
                    callback(null, true);
                  } else {
                    accessory.context.lastSwitchState = true;
                    callback(null, true);
                  }
                } else {
                  self.logger.errorinfo(accessory.displayName + 'An error occured by getting device state!');
                  self.logger.errorinfo(JSON.stringify(err,null,4));
                  callback(null, accessory.context.lastSwitchState);
                }
              });
            } else {
              callback(null, false);
            }
          })
          .on('set', function(state, callback) {
            let reconnect;
            self.platform.boxType == 'dsl' ? 
              reconnect = self.device.services['urn:dslforum-org:service:WANPPPConnection:1'] :
              reconnect = self.device.services['urn:dslforum-org:service:WANIPConnection:1'];
            if(state){
              self.logger.info(accessory.displayName + ': Please wait a moment, internet is reconnecting...');
              setTimeout(function(){service.getCharacteristic(Characteristic.On).updateValue(false);},500);
              callback(null, false);
            } else {
              reconnect.actions.ForceTermination(function() {
                self.logger.warninfo(accessory.displayName + ': Reconnecting internet...');
                accessory.context.lastSwitchState = false;
                setTimeout(function(){self.getIP(accessory,service);},15000);
                callback(null, false);
              });
            }
          });
        
        if(accessory.context.reboot&&self.platform.options.reboot){
          accessory.context.reboot = false;
          let ppp;
          self.platform.boxType == 'dsl' ? 
            ppp = self.device.services['urn:dslforum-org:service:WANPPPConnection:1'] :
            ppp = self.device.services['urn:dslforum-org:service:WANIPConnection:1'];
          ppp.actions.GetExternalIPAddress(function(err, res) {
            if(!err){
              let message = 'Network reboot completed. New External IP adress: ' + res.NewExternalIPAddress;
              self.logger.info(message);
              if(self.platform.options.reboot.telegram&&self.platform.options.reboot.chatID&&self.platform.options.reboot.token&&self.platform.options.reboot.messages){
                if(self.platform.options.reboot.messages.off && self.platform.options.reboot.messages.off != ''){
                  message = self.platform.options.reboot.messages.off;
                  message = message.replace('@', 'IP: ' + res.NewExternalIPAddress);
                  self.sendTelegram(self.platform.options.reboot.token,self.platform.options.reboot.chatID,message); 
                }
              }
            }else{
              let message = 'Network reboot completed';
              self.logger.info(message);
              self.logger.info('Can not get the new external IP Adress!');
              if(self.platform.options.reboot.telegram&&self.platform.options.reboot.chatID&&self.platform.options.reboot.token&&self.platform.options.reboot.messages){
                if(self.platform.options.reboot.messages.off&&self.platform.options.reboot.messages.off!=''){
                  message = self.platform.options.reboot.messages.off;
                  self.sendTelegram(self.platform.options.reboot.token,self.platform.options.reboot.chatID,message); 
                }
              }
            }
          });
        }
        break;
      case 2:
        if(accessory.context.accType == 'motion'){
          service = accessory.getService(Service.MotionSensor);
          service.getCharacteristic(Characteristic.MotionDetected)
            .updateValue(accessory.context.lastMotionState)
            .on('change', self.changeValue.bind(this, accessory, service, type, 'motion'));
  
          if (!service.testCharacteristic(Characteristic.EveMotionLastActivation))service.addCharacteristic(Characteristic.EveMotionLastActivation);
          service.getCharacteristic(Characteristic.EveMotionLastActivation)
            .updateValue(accessory.context.lastActivation);
        } else {
          service = accessory.getService(Service.OccupancySensor);
          service.getCharacteristic(Characteristic.OccupancyDetected)
            .updateValue(accessory.context.lastMotionState)
            .on('change', self.changeValue.bind(this, accessory, service, type, 'motion'));
        }

        if(Object.keys(self.platform.presence).length){
          if(accessory.displayName == 'Anyone'){
            if(self.platform.presenceOptions.anyoneSensor){
              if(accessory.context.accType == 'motion')self.getMotionLastActivation(accessory, service);
              setTimeout(function(){self.getAnyoneMotionDetected(accessory, service);},3000);
            }
          } else {
            for(const i of Object.keys(self.platform.presence)){
              if(accessory.displayName == i){
                if(accessory.context.accType == 'motion')self.getMotionLastActivation(accessory, service);
                setTimeout(function(){self.getMotionDetected(accessory, service);},1000);
              }
            }
          }
        }
        break;
      case 3:
        service = accessory.getService(Service.Switch);
        service.getCharacteristic(Characteristic.On)
          .updateValue(false)
          .on('set', function(state, callback) {
            if(state){
              let wol = self.device.services['urn:dslforum-org:service:Hosts:1'];
              wol.actions['X_AVM-DE_WakeOnLANByMACAddress']([{name:'NewMACAddress', value:accessory.context.mac}],function(err) {
                if(!err){
                  self.logger.info('Turning on ' + accessory.displayName);
                } else {
                  self.logger.errorinfo('An error occured by turning on ' + accessory.displayName);
                  self.logger.errorinfo(JSON.stringify(err,null,4));
                }
                setTimeout(function(){service.getCharacteristic(Characteristic.On).updateValue(false);},500);
                callback(null, false);
              });
            } else {
              callback(null, false);
            }
          });
        break;
      case 4:
        service = accessory.getService(Service.Switch);
        if(accessory.context.wifi2){ 
          if (!service.testCharacteristic(Characteristic.WifiTwo)){
            self.logger.initinfo('Adding WIFI 2.4 Ghz Characteristic to ' + accessory.displayName);
            accessory.context.lastWifiTwoState = false;
            service.addCharacteristic(Characteristic.WifiTwo);
          }
          service.getCharacteristic(Characteristic.WifiTwo)
            .updateValue(accessory.context.lastWifiTwoState)
            .on('set', self.setWifiTwo.bind(this, accessory, service))
            .on('get', self.checkWifiTwo.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.WifiTwo)){
            self.logger.initinfo('Removing WIFI 2.4 Ghz Characteristic from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.WifiTwo));
          }
        }

        if(accessory.context.wifi5){
          if(self.device.services['urn:dslforum-org:service:WLANConfiguration:3']){
            if (!service.testCharacteristic(Characteristic.WifiFive)){
              self.logger.initinfo('Adding WIFI 5 Ghz Characteristic to ' + accessory.displayName);
              accessory.context.lastWifiFiveState = false;
              service.addCharacteristic(Characteristic.WifiFive);
            }
            service.getCharacteristic(Characteristic.WifiFive)
              .updateValue(accessory.context.lastWifiFiveState)
              .on('set', self.setWifiFive.bind(this, accessory, service))
              .on('get', self.checkWifiFive.bind(this, accessory, service));
          } else {
            self.logger.warninfo(accessory.displayName + ': Can not add WIFI 5 Ghz, not supported by this device!');
          }
        } else {
          if(service.testCharacteristic(Characteristic.WifiFive)){
            self.logger.initinfo('Removing WIFI 5 Ghz Characteristic from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.WifiFive));
          }
        }

        if(accessory.context.wifiGuest){
          if (!service.testCharacteristic(Characteristic.WifiGuest)){
            self.logger.initinfo('Adding WIFI Guest Characteristic to ' + accessory.displayName);
            accessory.context.lastWifiGuestState = false;
            service.addCharacteristic(Characteristic.WifiGuest);
          }
          service.getCharacteristic(Characteristic.WifiGuest)
            .updateValue(accessory.context.lastWifiGuestState)
            .on('set', self.setWifiGuest.bind(this, accessory, service))
            .on('get', self.checkWifiGuest.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.WifiGuest)){
            self.logger.initinfo('Removing WIFI Guest from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.WifiGuest));
          }
        }

        if(accessory.context.led){
          if (!service.testCharacteristic(Characteristic.DeviceLED)){
            self.logger.initinfo('Adding LED Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.DeviceLED);
            accessory.context.lastLEDState = false;
          }
          service.getCharacteristic(Characteristic.DeviceLED)
            .updateValue(accessory.context.lastLEDState)
            .on('set', self.setDeviceLED.bind(this, accessory, service))
            .on('get', self.checkDeviceLED.bind(this, accessory, service));
        } else {
          if(service.testCharacteristic(Characteristic.DeviceLED)){
            self.logger.initinfo('Removing LED from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.DeviceLED));
          }
        }
        
        if(accessory.context.reboot){
          if (!service.testCharacteristic(Characteristic.Reboot)){
            self.logger.initinfo('Adding Reboot Characteristic to ' + accessory.displayName);
            service.addCharacteristic(Characteristic.Reboot);
          }
          service.getCharacteristic(Characteristic.Reboot)
            .updateValue(false)
            .on('set', function(state, callback) {
              if(state){
                let reboot = self.device.services['urn:dslforum-org:service:DeviceConfig:1'];
                reboot.actions.Reboot(function() {
                  self.logger.info(accessory.displayName + ': Rebooting...'); 
                });
                setTimeout(function(){service.getCharacteristic(Characteristic.Reboot).updateValue(false);},500);
                callback(null, false);
              } else {
                callback(null, false);
              }
            });
        } else {
          if(service.testCharacteristic(Characteristic.Reboot)){
            self.logger.initinfo('Removing Reboot from ' + accessory.displayName);
            service.removeCharacteristic(service.getCharacteristic(Characteristic.Reboot));
          }
        }

        service.getCharacteristic(Characteristic.On)
          .updateValue(accessory.context.lastSwitchState)
          .on('get', function(callback){
            let adress = parseInt(accessory.context.host);
            if(isNaN(adress)) {
              self.logger.warninfo(accessory.displayName + ': Setted value for ip in config ist not an numerical ip adress! Can not get repeater state!');
              accessory.context.lastSwitchState = false;
              setTimeout(function(){service.getCharacteristic(Characteristic.On).updateValue(false);},500);
              callback(null, false);
            } else {
              let host = self.device.services['urn:dslforum-org:service:WLANConfiguration:1'];
              if(!accessory.context.stopPolling){
                host.actions.GetInfo(function(err, result){
                  if(!err){
                    if(result.NewStatus == 'Up' && result.NewEnable == '1'){
                      accessory.context.lastSwitchState = true;
                      callback(null, true);
                    } else {
                      let host2;
                      if(self.device.services['urn:dslforum-org:service:WLANConfiguration:3']){
                        host2 = self.device.services['urn:dslforum-org:service:WLANConfiguration:2'];
                        host2.actions.GetInfo(function(errNew, resultNew){
                          if(!errNew){
                            if(resultNew.NewStatus == 'Up' && resultNew.NewEnable == '1'){
                              accessory.context.lastSwitchState = true;
                              callback(null, true);
                            } else {
                              accessory.context.lastSwitchState = false;
                              callback(null, false);
                            }
                          } else {
                            self.logger.errorinfo(accessory.displayName + ': An error occured by getting device state!');
                            self.logger.errorinfo(JSON.stringify(errNew,null,4));
                            callback(null, accessory.context.lastSwitchState);
                          }
                        });
                      } else {
                        accessory.context.lastSwitchState = false;
                        callback(null, false);
                      }
                    }
                  } else {
                    self.logger.errorinfo(accessory.displayName + ': An error occured by getting device state!');
                    self.logger.errorinfo(JSON.stringify(err,null,4));
                    callback(null, accessory.context.lastSwitchState);
                  }
                });
              } else {
                callback(null, false);
              }
            }
          })
          .on('set', function(state, callback) {
            if(state){
              setTimeout(function(){service.getCharacteristic(Characteristic.On).updateValue(true);},500);
              callback(null, true);
            } else {
              let reboot = self.device.services['urn:dslforum-org:service:DeviceConfig:1'];
              reboot.actions.Reboot(function() {
                self.logger.info(accessory.displayName + ': Rebooting...'); 
              });
              setTimeout(function(){service.getCharacteristic(Characteristic.On).updateValue(true);},5*60*1000);
              callback(null, false);
            }
          });
        break;
      case 5:
        service = accessory.getService(Service.ContactSensor);
        service.getCharacteristic(Characteristic.ContactSensorState)
          .updateValue(accessory.context.lastContactSensorState);
        if(self.config.callmonitor&&!self.config.callmonitor.disable)self.getContactState(accessory, service);
        break;
      case 6:
        switch(accessory.context.accType){
          case 'plug':
            service = accessory.getService(Service.Switch);
            service.getCharacteristic(Characteristic.On)
              .updateValue(accessory.context.lastHASwitchState)
              .on('set', self.setHASwitchState.bind(this, accessory, service)); 
            break;
          case 'thermo':
            service = accessory.getService(Service.Thermostat);
            break;
          case 'contact':
            service = accessory.getService(Service.ContactSensor);
            break;
          default:
            break;
        }
        self.checkHASwitchState(accessory, service, accessory.context.accType);
        break;
      default:
        break;
    }
  }
  
  getIP(accessory,service){
    const self = this;
    let ppp;
    self.platform.boxType == 'dsl' ? 
      ppp = self.device.services['urn:dslforum-org:service:WANPPPConnection:1'] :
      ppp = self.device.services['urn:dslforum-org:service:WANIPConnection:1'];
    ppp.actions.GetExternalIPAddress(function(err, res) {
      if(!err){
        self.logger.info(accessory.displayName + ': Reconnect successfull. New external ip adress is: ' + res.NewExternalIPAddress);
      }else{
        self.logger.info(accessory.displayName + ': Reconnect successfull');
      }
      accessory.context.lastSwitchState = true;
      service.getCharacteristic(Characteristic.On).updateValue(accessory.context.lastSwitchState);
    });
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // FritzBox LUA
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  fetchSID(accessory, callback){
    const self = this;
    let getSID = self.device.services['urn:dslforum-org:service:DeviceConfig:1'];
    getSID.actions['X_AVM-DE_CreateUrlSID'](function(err, result) {
      if(!err){
        let sid = result['NewX_AVM-DE_UrlSID'].split('sid=')[1];
        callback(null, sid);
      } else {
        callback(err, null);
      }
    });
  }

  parseOutput(accessory, service, data, type, callback){
    let $ = cheerio.load(data);
    let form = $('form');
    $('input', form).each(function(i, elem) {
      let name = $(elem).attr('name');
      if (!name) callback('No name defined!',null);
      switch ($(elem).attr('type')) {
        case 'checkbox':
          if(type == 'keylock'){
            if (name == 'keylock_enabled'){
              if ($(elem).attr('checked') === 'checked') {
                accessory.context.lastDeviceLock = true;
                callback(null, true);
              } else {
                accessory.context.lastDeviceLock = false;
                callback(null, false);
              }
            }
          }
          break;
        case 'radio':
          if(type == 'led_one'){
            if (name == 'led_display'){
              if($(elem).attr('value') === '0'){
                if ($(elem).attr('checked') === 'checked') {
                  accessory.context.lastLEDState = true;
                  callback(null, true);
                } else {
                  accessory.context.lastLEDState = false;
                  callback(null, false);
                }
              }
            }
          }
          break;
        default:
      }
    });
  }
  
  setDeviceLock(accessory, service, state, callback){
    const self = this;
    let formData;
    if(!accessory.context.options.host.match('myfritz')){
      self.fetchSID(accessory, function(err, result){
        if(!err){
          let sid = result;
          if(state){
            formData = querystring.stringify({
              xhr: '1',
              sid: sid,
              no_sidrenew: '',
              keylock_enabled: '1',
              apply: '',
              oldpage: '/system/keylock.lua'
            });
          } else {
            formData = querystring.stringify({
              xhr: '1',
              sid: sid,
              no_sidrenew: '',
              apply: '',
              oldpage: '/system/keylock.lua'
            });
          }
          request.post('http://' + accessory.context.options.host + '/data.lua?sid='+sid,{form:formData}, function(error, response, body){
            if (!error && (response.statusCode == 200 || response.statusCode == 303)){
              state ? self.logger.info(accessory.displayName + ': Turning on Device Lock') : self.logger.info(accessory.displayName + ': Turning off Device Lock');
              callback(null, state);
            } else {
              self.logger.errorinfo(accessory.displayName + ':An error occured by setting \'Device Lock\'!');
              let showError = {
                error: error?error.errno:response.statusMessage,
                errorCode: error?error.code:response.statusCode
              };
              self.logger.errorinfo(JSON.stringify(showError,null,4));
              setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLock).updateValue(state?false:true);}, 500);
              callback(null, state?false:true);
            }
          });
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by fetching new SID for \'Device Lock\'!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
          setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLock).updateValue(accessory.context.lastDeviceLock);}, 500);
          callback(null, accessory.context.lastDeviceLock);
        }
      });
    } else {
      self.logger.warninfo('Can not set Device Lock in remote mode!');
      setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLock).updateValue(false);}, 500);
      callback(null, false);
    }
  }
  
  setRefreshChannel(accessory, service, state, callback){
    const self = this;
    if(state){
      if(!accessory.context.options.host.match('myfritz')){
        let formData;
        self.fetchSID(accessory, function(err, result){
          if(!err){
            let sid = result;
            formData = querystring.stringify({
              xhr: '1',
              channelSelectMode: 'auto',
              airslot: '1',
              refresh: '',
              sid: sid,
              page: 'chan'
            });
            request.post('http://' + accessory.context.options.host + '/data.lua?sid='+sid,{form:formData}, function(error, response, body){
              if (!error && (response.statusCode == 200 || response.statusCode == 303)){
                self.logger.info(accessory.displayName + ': WIFI Channel refreshed!');
                setTimeout(function(){service.getCharacteristic(Characteristic.RefreshChannel).updateValue(false);}, 500);
                callback(null, false);
              } else {
                self.logger.errorinfo(accessory.displayName + ':An error occured by refreshing \'WIFI Channel\'!');
                let showError = {
                  error: error?error.errno:response.statusMessage,
                  errorCode: error?error.code:response.statusCode
                };
                self.logger.errorinfo(JSON.stringify(showError,null,4));
                setTimeout(function(){service.getCharacteristic(Characteristic.RefreshChannel).updateValue(false);}, 500);
                callback(null, false);
              }
            });
          } else {
            self.logger.errorinfo(accessory.displayName + ': An error occured by fetching new SID for \'Refresh Channel\'!');
            self.logger.errorinfo(JSON.stringify(err,null,4));
          }
        });
      } else {
        self.logger.warninfo('Can not refresh WIFI channel in remote mode!');
      }
      setTimeout(function(){service.getCharacteristic(Characteristic.RefreshChannel).updateValue(false);}, 500);
      callback(null, false);
    } else {
      callback(null, false);
    }
  }

  checkDeviceLock(accessory, service, callback){
    const self = this; 
    if(!accessory.context.options.host.match('myfritz')){
      self.fetchSID(accessory, function(err, result){
        if(!err){
          let sid = result;
          request('http://' + accessory.context.options.host + '/system/keylock.lua?sid='+sid,function(error, response, body){
            if (!error && (response.statusCode == 200 || response.statusCode == 303)){
              self.parseOutput(accessory, service, body,'keylock', function(err, result){
                if(!err){
                  callback(null, result);
                } else {
                  self.logger.errorinfo(accessory.displayName + ':An error occured by getting Device Lock state!');
                  self.logger.errorinfo(JSON.stringify(err,null,4));
                  setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLock).updateValue(accessory.context.lastDeviceLock);}, 500);
                  callback(null, accessory.context.lastDeviceLock);
                }
              });
            } else {
              self.logger.errorinfo(accessory.displayName + ':An error occured by getting Device Lock!');
              let showError = {
                error: error?error.errno:response.statusMessage,
                errorCode: error?error.code:response.statusCode
              };
              self.logger.errorinfo(JSON.stringify(showError,null,4));
              setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLock).updateValue(accessory.context.lastDeviceLock);}, 500);
              callback(null, accessory.context.lastDeviceLock);
            }
          });
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by fetching new SID for \'Device Lock\'!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
          setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLock).updateValue(accessory.context.lastDeviceLock);}, 500);
          callback(null, accessory.context.lastDeviceLock);
        }
      });
    } else {
      self.logger.warninfo('Can not get Device Lock state in remote mode!');
      setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLock).updateValue(false);}, 500);
      callback(null, false);
    }
  }

  setDeviceLED(accessory, service, state, callback){
    const self = this;
    let formData;
    self.fetchSID(accessory, function(err, result){
      if(!err){
        let sid = result;
        if(state){
          formData = querystring.stringify({
            xhr: '1',
            sid: result,
            no_sidrenew: '',
            led_display: '0',
            apply: '',
            oldpage: '/system/led_display.lua'
          });
        } else {
          formData = querystring.stringify({
            xhr: '1',
            sid: result,
            no_sidrenew: '',
            led_display: '2',
            apply: '',
            oldpage: '/system/led_display.lua'
          });
        }
        request.post('http://' + accessory.context.options.host + '/system/led_display.lua?sid='+sid,{form:formData}, function(error, response, body){
          if (!error && (response.statusCode == 200 || response.statusCode == 303)){
            state ? self.logger.info(accessory.displayName + ': Turning on LEDs') : self.logger.info(accessory.displayName + ': Turning off LEDs');
            callback(null, state);
          } else {
            self.logger.errorinfo(accessory.displayName + ':An error occured by setting LED state!');
            let showError = {
              error: error?error.errno:response.statusMessage,
              errorCode: error?error.code:response.statusCode
            };
            self.logger.errorinfo(JSON.stringify(showError,null,4));
            setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLED).updateValue(state?false:true);}, 500);
            callback(null, state?false:true);
          }
        });
      } else {
        self.logger.errorinfo(accessory.displayName + ': An error occured by fetching new SID for \'Device LED\'!');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLED).updateValue(accessory.context.lastLEDState);}, 500);
        callback(null, accessory.context.lastLEDState);
      }
    });
  }

  checkDeviceLED(accessory, service, callback){
    const self = this; 
    self.fetchSID(accessory, function(err, result){
      if(!err){
        let sid = result;
        request('http://' + accessory.context.options.host + '/system/led_display.lua?sid='+sid, function(error, response, body){
          if (!error && response.statusCode == 200){
            self.parseOutput(accessory, service, body,'led_one', function(err, result){
              if(!err){
                callback(null, result);
              } else {
                self.logger.errorinfo(accessory.displayName + ':An error occured by getting LED state!');
                self.logger.errorinfo(JSON.stringify(err,null,4));
                setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLED).updateValue(accessory.context.lastLEDState);}, 500);
                callback(null, accessory.context.lastLEDState);
              }
            });
          } else {
            self.logger.errorinfo(accessory.displayName + ':An error occured by getting LED state!');
            let showError = {
              error: error?error.errno:response.statusMessage,
              errorCode: error?error.code:response.statusCode
            };
            self.logger.errorinfo(JSON.stringify(showError,null,4));
            setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLED).updateValue(accessory.context.lastLEDState);}, 500);
            callback(null, accessory.context.lastLEDState);
          }
        });
      } else {
        self.logger.errorinfo(accessory.displayName + ': An error occured by fetching new SID for \'Device LED\'!');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        setTimeout(function(){service.getCharacteristic(Characteristic.DeviceLED).updateValue(accessory.context.lastLEDState);}, 500);
        callback(null, accessory.context.lastLEDState);
      }
    });
  }
  
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Telegram
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  
  sendTelegram(token,chatID,text){
    const self = this;
    request.post('https://api.telegram.org/bot' + token + '/sendMessage',{body:{'chat_id': chatID,'text': text},json:true}, function(error, response, body){
      if (!error && (response.statusCode == 200 || response.statusCode == 303)){
        self.logger.info('Successfully send telegram notification!');
      } else {
        self.logger.errorinfo('An error occured by sending telegram notification!');
        let showError = {
          error: error?error.errno:response.statusMessage,
          errorCode: error?error.code:response.statusCode
        };
        self.logger.errorinfo(JSON.stringify(showError,null,4));
      }
    });
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Callmonitor
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  fritzboxDateToUnix(string) {
    let d = string.match(/[0-9]{2}/g);
    let result = '';
    result += '20' + d[2] + '-' + d[1] + '-' + d[0];
    result += ' ' + d[3] + ':' + d[4] + ':' + d[5];
    return Math.floor(new Date(result).getTime() / 1000);
  }

  parseMessage(buffer) {
    const self = this;
    let message = buffer.toString()
      .toLowerCase()
      .replace(/[\n\r]$/, '')
      .replace(/;$/, '')
      .split(';');
    message[0] = self.fritzboxDateToUnix(message[0]);
    return message;
  }

  getContactState(accessory, service){
    const self = this;
    self.client.on('error', () => {
      accessory.context.lastContactSensorState = false;
      service.getCharacteristic(Characteristic.ContactSensorState).updateValue(accessory.context.lastContactSensorState);
    });

    self.client.on('data', chunk => {

      let data = self.parseMessage(chunk);
      let text;
      let message;

      if(accessory.displayName == 'Callmonitor Incoming'){
        if (data[1] === 'ring') {
          self.call[data[2]] = {
            type: 'inbound',
            start: data[0],
            caller: data[3],
            called: data[4]
          };
          message = {
            time: data[0],
            caller: data[3],
            called: data[4]
          };
          accessory.context.lastContactSensorState = true;
          service.getCharacteristic(Characteristic.ContactSensorState).updateValue(accessory.context.lastContactSensorState); 
          if(self.storage.getItem('PhoneBook.js')){
            let phonebook = self.storage.getItem('PhoneBook.js');
            let skip = false;
            for(const i in phonebook){
              if(message.caller == phonebook[i].number){
                text = 'Incoming call from: ' + phonebook[i].name + ' ( '+ phonebook[i].number + ' ) to ' + message.called;
                self.callerName = phonebook[i].name;
                self.callerNr = phonebook[i].number;
                skip = true;
              }
            }
            if(!skip){
              text = 'Incoming call from: ' + message.caller + ' to ' + message.called;
              self.callerNr = message.caller;
              self.callerName = false;
            }
          } else {
            text = 'Incoming call from: ' + message.caller + ' to ' + message.called;
            self.callerNr = message.caller;
            self.callerName = false;
          }
          self.logger.info(text);
          if(self.platform.callmonitor.telegram&&self.platform.callmonitor.chatID&&self.platform.callmonitor.token&&self.platform.callmonitor.messages){
            if(self.platform.callmonitor.messages.incoming&&self.platform.callmonitor.messages.incoming!=''){
              let parseInfo;
              (self.callerName&&self.callerNr) ? parseInfo = self.callerName + ' ( ' + self.callerNr + ' )' : parseInfo = self.callerNr + ' ( No name )';
              text = self.platform.callmonitor.messages.incoming;
              text = text.replace('@', parseInfo).replace('%', message.called);
              self.sendTelegram(self.platform.callmonitor.token,self.platform.callmonitor.chatID,text); 
            }
          }

        }
      }

      if(accessory.displayName == 'Callmonitor Outgoing'){
        if (data[1] === 'call') {
          self.call[data[2]] = {
            type: 'outbound',
            start: data[0],
            extension: data[3],
            caller: data[4],
            called: data[5]
          };
          message = {
            time: data[0],
            extension: data[3],
            caller: data[4],
            called: data[5]
          };
          accessory.context.lastContactSensorState = true;
          service.getCharacteristic(Characteristic.ContactSensorState).updateValue(accessory.context.lastContactSensorState);
          service.getCharacteristic(Characteristic.ContactSensorState).updateValue(accessory.context.lastContactSensorState);
          let called = message.called.replace(/\D/g,''); 
          if(self.storage.getItem('PhoneBook.js')){
            let phonebook = self.storage.getItem('PhoneBook.js');
            let skip = false;
            for(const i in phonebook){
              if(called == phonebook[i].number){
                text = 'Calling: ' + phonebook[i].name + ' ( '+ phonebook[i].number + ' )';
                skip = true;
              }
            }
            if(!skip){
              text = 'Calling: ' + called;
            }
          } else {
            text = 'Calling: ' + called;
          }
          self.logger.info(text);
        }
      }

      if (data[1] === 'connect') {
        if(self.call[data[2]]){
          self.call[data[2]]['connect'] = data[0];
          message = {
            time: data[0],
            extension: self.call[data[2]]['extension'],
            caller: self.call[data[2]]['caller'],
            called: self.call[data[2]]['called']
          };
          accessory.context.lastContactSensorState = true;
          service.getCharacteristic(Characteristic.ContactSensorState).updateValue(accessory.context.lastContactSensorState);
          self.logger.info('Connection established from: ' + message.caller + ' - to: ' + message.called);
        }
      }

      if (data[1] === 'disconnect') {
        if(self.call[data[2]]){
          self.call[data[2]].disconnect = data[0];
          self.call[data[2]].duration = parseInt(data[3], 10);
          let call = self.call[data[2]];
          delete(self.call[data[2]]);
          message = call;
          accessory.context.lastContactSensorState = false;
          service.getCharacteristic(Characteristic.ContactSensorState).updateValue(accessory.context.lastContactSensorState);
          self.logger.info('Call disconnected');
          if(accessory.displayName == 'Callmonitor Incoming'){
            if(self.platform.callmonitor.telegram&&self.platform.callmonitor.chatID&&self.platform.callmonitor.token&&self.platform.callmonitor.messages){
              if(self.platform.callmonitor.messages.disconnected&&self.platform.callmonitor.messages.disconnected!=''){
                let parseInfo;
                (self.callerName&&self.callerNr) ? parseInfo = self.callerName + ' ( ' + self.callerNr + ' )' : parseInfo = self.callerNr + ' ( No name )';
                text = self.platform.callmonitor.messages.disconnected;
                text = text.replace('@', parseInfo);
                self.sendTelegram(self.platform.callmonitor.token,self.platform.callmonitor.chatID,text); 
              }
            }
          }
        }
      }

    });

    self.client.on('end', () => {
      accessory.context.lastContactSensorState = false;
      service.getCharacteristic(Characteristic.ContactSensorState).updateValue(accessory.context.lastContactSensorState);
      self.client.end();
    });
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Extra Characteristics // Sets
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  setPhoneBook(accessory, service, state, callback){
    const self = this;
    let book = self.device.services['urn:dslforum-org:service:X_AVM-DE_OnTel:1'];
    !self.entryID ? self.entryID = 0 : self.entryID;
    !self.bookIDs ? self.bookIDs = [] : self.bookIDs;
    !self.currentID ? self.currentID = 0 : self.currentID;
    !self.telBook ? self.telBook = [] : self.telBook;
    if(state){
      self.logger.info('Refreshing phone book...');
      book.actions.GetPhonebookList(function(err, res) {
        if(!err){
          self.bookIDs = res.NewPhonebookList.split(',');
          self.logger.info('Found ' + self.bookIDs.length + ' books! Fetching entries...');
          self.storeEntries(accessory,service);
        } else {
          self.logger.errorinfo('An error occured by getting phone books!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
        }
      });
      setTimeout(function(){service.getCharacteristic(Characteristic.PhoneBook).setValue(false);},500);
      callback(null, false);
    } else {
      callback(null, false);
    }
  }

  storeEntries(accessory, service){
    const self = this;
    let book = self.device.services['urn:dslforum-org:service:X_AVM-DE_OnTel:1'];
    book.actions.GetPhonebookEntry([{name:'NewPhonebookID',value:self.currentID.toString()},{name:'NewPhonebookEntryID',value:self.entryID.toString()}],function(err, res) {
      if(!err&&res){
        parseString(res.NewPhonebookEntryData,{explicitArray: false,}, function (error, result) {
          if(!error){
            let numbers = result.contact.telephony.number;
            if(numbers.length){
              for(const i in numbers){
                let telnr = numbers[i]._.replace('+49', '0').replace('+90', '0090').replace(/\D/g,'');
                self.telBook.push({name: result.contact.person.realName,number:telnr});
              }
            } else {
              let telnr = numbers._.replace('+49', '0').replace(/\D/g,'');
              self.telBook.push({name: result.contact.person.realName,number:telnr});
            }
            self.entryID += 1;
            setTimeout(function(){self.storeEntries(accessory,service);},500);
          } else {
            self.logger.errorinfo(accessory.displayName + ': An error occured by fetching phone book!');
            self.logger.errorinfo(JSON.stringify(error,null,4));
            self.telBook = [];
            self.entryID = 0;
            self.bookIDs = [];
            self.currentID = 0;
          }
        });
      } else {
        if(err.tr064code&&err.tr064code == '713'){
          self.entryID = 0;
          if(self.currentID < self.bookIDs.length){
            self.logger.info('Phone book [' + self.currentID + '] done. Looking for another books!');
            setTimeout(function(){self.storeEntries(accessory, service);},500);
            self.currentID += 1;
          } else if (self.currentID == self.bookIDs.length){
            self.logger.info('Found ' + self.telBook.length + ' entries in phone book [' + self.bookIDs + ']. Setting it to storage!');
            self.storage.setItem('PhoneBook.js', self.telBook);
            self.currentID = 0;
            self.telBook = [];
          }
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by getting phone book!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
          self.telBook = [];
          self.entryID = 0;
          self.bookIDs = [];
          self.currentID = 0;
        }
      }
    });
  }
  
  setHASwitchState(accessory, service, state, callback){
    const self = this;
    let homeauto = self.device.services['urn:dslforum-org:service:X_AVM-DE_Homeauto:1'];
    let status;
    state ? status = 'ON' : status = 'OFF';
    homeauto.actions.SetSwitch([{name:'NewAIN', value:accessory.context.ain},{name:'NewSwitchState', value:status}],function(err) {
      if(!err){
        state ? self.logger.info(accessory.displayName + ': Turning on ' + accessory.displayName) : self.logger.info(accessory.displayName + ': Turning off ' + accessory.displayName);
        accessory.context.lastHASwitchstate = state;
        callback(null, state);
      } else {
        state ? self.logger.errorinfo(accessory.displayName + ': An error occured by turning on ' + accessory.displayName) : self.logger.errorinfo(accessory.displayName + ': An error occured by turning off ' + accessory.displayName);
        self.logger.errorinfo(JSON.stringify(err,null,4));
        accessory.context.lastHASwitchstate = state ? false : true;
        setTimeout(function(){service.getCharacteristic(Characteristic.On).updateValue(accessory.context.lastHASwitchstate);},500);
        callback(null, accessory.context.lastHASwitchstate);
      }
    });
  }

  setWifiTwo(accessory, service, state, callback){
    const self = this;
    let wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:1'];
    let status;
    state ? status = '1' : status = '0';
    wlan.actions.SetEnable([{name:'NewEnable', value:status}],function(err) {
      if(!err){
        state ? self.logger.info(accessory.displayName + ': Turning on WIFI 2.4 Ghz') : self.logger.info(accessory.displayName + ': Turning off WIFI 2.4 Ghz');
        accessory.context.lastWifiTwoState = state;
        callback(null, state);
      } else {
        state ? self.logger.errorinfo(accessory.displayName + ': An error occured by turning on WIFI 2.4 Ghz') : self.logger.errorinfo(accessory.displayName + ': An error occured by turning off WIFI 2.4 Ghz');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        accessory.context.lastWifiTwoState = state ? false : true;
        setTimeout(function(){service.getCharacteristic(Characteristic.WifiTwo).updateValue(accessory.context.lastWifiTwoState);},500);
        callback(null, accessory.context.lastWifiTwoState);
      }
    });
  }

  setWifiFive(accessory, service, state, callback){
    const self = this;
    let wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:2'];
    let status;
    state ? status = '1' : status = '0';
    wlan.actions.SetEnable([{name:'NewEnable', value:status}],function(err) {
      if(!err){
        state ? self.logger.info(accessory.displayName + ': Turning on WIFI 5 Ghz') : self.logger.info(accessory.displayName + ': Turning off WIFI 5 Ghz');
        accessory.context.lastWifiFiveState = state;
        callback(null, state);
      } else {
        state ? self.logger.errorinfo(accessory.displayName + ': An error occured by turning on WIFI 5 Ghz') : self.logger.errorinfo(accessory.displayName + ': An error occured by turning off WIFI 5 Ghz');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        accessory.context.lastWifiFiveState = state ? false : true;
        setTimeout(function(){service.getCharacteristic(Characteristic.WifiFive).updateValue(accessory.context.lastWifiFiveState);},500);
        callback(null, accessory.context.lastWifiFiveState);
      }
    });
  }

  setWifiGuest(accessory, service, state, callback){
    const self = this;
    let wlan;
    if(self.device.services['urn:dslforum-org:service:WLANConfiguration:3']){
      wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:3'];
    } else {
      wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:2'];
    }
    let status;
    state ? status = '1' : status = '0';
    wlan.actions.SetEnable([{name:'NewEnable', value:status}],function(err) {
      if(!err){
        state ? self.logger.info(accessory.displayName + ': Turning on WIFI Guest') : self.logger.info(accessory.displayName + ': Turning off WIFI Guest');
        accessory.context.lastWifiGuestState = state;
        callback(null, state);
      } else {
        state ? self.logger.errorinfo(accessory.displayName + ': An error occured by turning on WIFI Guest') : self.logger.errorinfo(accessory.displayName + ': An error occured by turning off WIFI Guest');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        accessory.context.lastWifiGuestState = state ? false : true;
        setTimeout(function(){service.getCharacteristic(Characteristic.WifiGuest).updateValue(accessory.context.lastWifiGuestState);},500);
        callback(null, accessory.context.lastWifiGuestState);
      }
    });
  }

  setWifiWPS(accessory, service, state, callback){
    const self = this;
    let wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:1'];
    let status;
    state ? status = 'pbc' : status = 'stop';
    self.wpsTimer = moment().unix();
    wlan.actions['X_AVM-DE_SetWPSConfig']([{name:'NewX_AVM-DE_WPSMode', value:status},{name:'NewX_AVM-DE_WPSClientPIN',value:''}],function(err) {
      if(!err){
        state ? self.logger.info(accessory.displayName + ': Turning on WIFI WPS for 2 minutes!') : self.logger.info(accessory.displayName + ': Turning off WIFI WPS');
        accessory.context.lastWifiWPSState = state;
        callback(null, state);
      } else {
        state ? self.logger.errorinfo(accessory.displayName + ': An error occured by turning on WIFI WPS') : self.logger.errorinfo(accessory.displayName + ': An error occured by turning off WIFI WPS');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        accessory.context.lastWifiWPSState = state ? false : true;
        setTimeout(function(){service.getCharacteristic(Characteristic.WifiWPS).updateValue(accessory.context.lastWifiWPSState);},500);
        callback(null, accessory.context.lastWifiWPSState);
      }
    });
  }

  setAW(accessory, service, state, callback){
    const self = this;
    let aw = self.device.services['urn:dslforum-org:service:X_AVM-DE_TAM:1'];
    let status;
    state ? status = '1' : status = '0';
    aw.actions.SetEnable([{name:'NewIndex', value:'0'},{name:'NewEnable', value:status}],function(err) {
      if(!err){
        state ? self.logger.info(accessory.displayName + ': Turn on Answering Machine') : self.logger.info(accessory.displayName + ': Turn off Answering Machine');
        accessory.context.lastAWState = state;
        callback(null, state);
      } else {
        state ? self.logger.errorinfo(accessory.displayName + ': An error occured by turning on Answering Machine') : self.logger.errorinfo(accessory.displayName + ': An error occured by turning off Answering Machine');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        accessory.context.lastAWState = state ? false : true;
        setTimeout(function(){service.getCharacteristic(Characteristic.AnsweringMachine).updateValue(accessory.context.lastAWState);},500);
        callback(null, accessory.context.lastAWState);
      }
    });
  }

  setReboot(accessory, service, state, callback){
    const self = this;
    if(state){
      if(self.platform.reboot.cmd_on&&self.platform.reboot.cmd_off){
        self.logger.info(accessory.displayName + ': Initialising reboot...');
        accessory.context.stopPolling = true;
        for(const i in self.accessories)self.accessories[i].context.stopPolling = true;
        self.logger.info(accessory.displayName + ': Polling were stopped!');
        exec(self.platform.reboot.cmd_on, function (error, stdout, stderr) {
          if(!error){
            if(stdout == 1){
              self.logger.info(accessory.displayName + ': All homebridge instances were stopped! Preparing for reboot...');
              let reboot = self.device.services['urn:dslforum-org:service:DeviceConfig:1'];
              reboot.actions.Reboot(function() {
                accessory.context.reboot = true;
                if(self.platform.options.reboot.telegram&&self.platform.options.reboot.chatID&&self.platform.options.reboot.token&&self.platform.options.reboot.messages){
                  if(self.platform.options.reboot.messages.on&&self.platform.options.reboot.messages.on!=''){
                    let message = self.platform.options.reboot.messages.on;
                    self.sendTelegram(self.platform.options.reboot.token,self.platform.options.reboot.chatID,message); 
                  }
                }
                for(const i in self.accessories)self.accessories[i].context.stopPolling = true;
                self.logger.info(accessory.displayName + ': Homebridge instances will be restarted automatically in 5 minutes!');
                self.logger.info(accessory.displayName + ': Rebooting...'); 
                exec(self.platform.reboot.cmd_off, function (error, stdout, stderr) {
                  if(!error){
                    self.logger.info(accessory.displayName + ': All homebridge instances were restarted!');
                    accessory.context.stopPolling = false;
                    for(const i in self.accessories)self.accessories[i].context.stopPolling = false;
                  } else {
                    self.logger.errorinfo(accessory.displayName + ': An error occured by executing the CMD_OFF script Please restart manually all your homebridge instances!');
                    self.logger.errorinfo(stderr);
                    accessory.context.stopPolling = false;
                    for(const i in self.accessories)self.accessories[i].context.stopPolling = false;
                  }
                });
              });
            } else {
              self.logger.warninfo('Can not continue with rebooting! Please add \'echo 1\' at the end of your ON script!');
              accessory.context.stopPolling = false;
              for(const i in self.accessories)self.accessories[i].context.stopPolling = false;
            }
          } else {
            self.logger.errorinfo(accessory.displayName + ': An error occured by executing the CMD_ON script!');
            self.logger.errorinfo(stderr);
            setTimeout(function(){service.getCharacteristic(Characteristic.Reboot).updateValue(false);},500);
            accessory.context.stopPolling = false;
            for(const i in self.accessories)self.accessories[i].context.stopPolling = false;
          }
        });
      } else {
        let reboot = self.device.services['urn:dslforum-org:service:DeviceConfig:1'];
        self.logger.info('Polling werde stopped!');
        accessory.context.stopPolling = true;
        reboot.actions.Reboot(function() {
          accessory.context.reboot = true;
          if(self.platform.options.reboot.telegram&&self.platform.options.reboot.chatID&&self.platform.options.reboot.token&&self.platform.options.reboot.messages){
            if(self.platform.options.reboot.messages.on&&self.platform.options.reboot.messages.on!=''){
              let message = self.platform.options.reboot.messages.on;
              self.sendTelegram(self.platform.options.reboot.token,self.platform.options.reboot.chatID,message);
            }
          }
          for(const i in self.accessories)self.accessories[i].context.stopPolling = true;
          self.logger.info(accessory.displayName + ': Rebooting...');
        });
      }
      setTimeout(function(){service.getCharacteristic(Characteristic.Reboot).updateValue(false);},500);
      callback(null, false);
    } else {
      setTimeout(function(){service.getCharacteristic(Characteristic.Reboot).updateValue(false);},500);
      callback(null, false);
    }
  }
  
  setDeflection(accessory, service, state, callback){
    const self = this;
    let deflection = self.device.services['urn:dslforum-org:service:X_AVM-DE_OnTel:1'];
    let status;
    deflection.actions.GetNumberOfDeflections(function(err, result) {
      if(!err){
        if(result.NewNumberOfDeflections != '0'){
          state ? status = '1' : status = '0';
          deflection.actions.SetDeflectionEnable([{name:'NewDeflectionId',value:'0'}, {name:'NewEnable',value:status}],function(err) {
            if(!err){
              state ? self.logger.info(accessory.displayName + ': Turning on Deflection') : self.logger.info(accessory.displayName + ': Turning off Deflection');
              accessory.context.lastDeflectionState = state;
              callback(null, state);
            } else {
              state ? self.logger.errorinfo(accessory.displayName + ': An error occured by turning on Deflection') : self.logger.errorinfo(accessory.displayName + ': An error occured by turning off Deflection');
              self.logger.errorinfo(JSON.stringify(err,null,4));
              accessory.context.lastDeflectiontate = state ? false : true;
              setTimeout(function(){service.getCharacteristic(Characteristic.Deflection).updateValue(accessory.context.lastDeflectionState);},500);
              callback(null, accessory.context.lastDeflectionState);
            }
          });

        } else {
          state ? self.logger.warninfo('Cant turn on declection, no deflections setted up in fritz.box settings!') : self.logger.warninfo('Cant turn off declection, no deflections setted up in fritz.box settings!');
          let backState = state ? false : true;
          setTimeout(function(){service.getCharacteristic(Characteristic.Deflection).updateValue(backState);},500);
          callback(null, backState);
        }
      } else {
        self.logger.errorinfo(accessory.displayName + ': An error occured by setting deflections! Trying again...');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        let backState = state ? false : true;
        setTimeout(function(){service.getCharacteristic(Characteristic.Deflection).updateValue(backState);},500);
        callback(null, backState);
      }
    });
  }

  setWakeUp(accessory, service, state, callback){
    const self = this;
    let wakeup = self.device.services['urn:dslforum-org:service:X_VoIP:1'];
    if(state){
      wakeup.actions['X_AVM-DE_DialNumber']([{name:'NewX_AVM-DE_PhoneNumber',value:accessory.context.internNr}],function(err, result) {
        if(!err||result){
          self.logger.info(accessory.displayName + ': Calling ' + accessory.context.internNr + ' for ' + accessory.context.wakeupDuration/1000 + ' seconds');
          self.sleep(accessory.context.wakeupDuration).then(() => {
            service.getCharacteristic(Characteristic.WakeUp).setValue(false);
          });
          callback(null, true);
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by turning on \'Wake Up\'!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
          setTimeout(function(){service.getCharacteristic(Characteristic.WakeUp).updateValue(false);},500);
          callback(null, false);
        }
      });
    } else {
      wakeup.actions['X_AVM-DE_DialHangup'](function(err, result) {
        if(!err||result){
          self.logger.info(accessory.displayName + ': Stop calling. Turning off \'Wake Up\'');
          callback(null, false);
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by turning off \'Wake Up\'!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
          setTimeout(function(){service.getCharacteristic(Characteristic.WakeUp).updateValue(true);},500);
          callback(null, true);
        }
      });
    }
  }

  setAlarm(accessory, service, state, callback){
    const self = this;
    let alarm = self.device.services['urn:dslforum-org:service:X_VoIP:1'];
    if(state){
      alarm.actions['X_AVM-DE_DialNumber']([{name:'NewX_AVM-DE_PhoneNumber',value:accessory.context.alarmNumber}],function(err, result) {
        if(!err||result){
          let message = 'Alarm activated! Calling ' + accessory.context.alarmNumber + ' for ' + (accessory.context.alarmDuration/1000) + ' seconds';
          self.logger.info(accessory.displayName + ': ' + message);
          if(self.platform.alarm.telegram&&self.platform.alarm.chatID&&self.platform.alarm.token&&self.platform.alarm.messages){
            if(self.platform.alarm.messages.activated && self.platform.alarm.messages.activated!=''){
              message = self.platform.alarm.messages.activated;
              message = message.replace('@', accessory.context.alarmNumber);
              self.sendTelegram(self.platform.alarm.token,self.platform.alarm.chatID,message); 
            }
          }
          self.sleep(accessory.context.alarmDuration).then(() => {
            if(service.getCharacteristic(Characteristic.DialAlarm).value)service.getCharacteristic(Characteristic.DialAlarm).setValue(false);
          });
          callback(null, true);
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by turning on \'Alarm\'!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
          setTimeout(function(){service.getCharacteristic(Characteristic.DialALarm).updateValue(false);},500);
          callback(null, false);
        }
      });
    } else {
      alarm.actions['X_AVM-DE_DialHangup'](function(err, result) {
        if(!err||result){
          let message = 'Stop calling. Turning off \'Alarm\'';
          self.logger.info(accessory.displayName + ': ' + message);
          if(self.platform.alarm.telegram&&self.platform.alarm.chatID&&self.platform.alarm.token&&self.platform.alarm.messages){
            if(self.platform.alarm.messages.deactivated&&self.platform.alarm.messages.deactivated!=''){
              message = self.platform.alarm.messages.deactivated;
              self.sendTelegram(self.platform.alarm.token,self.platform.alarm.chatID,message);
            }
          }
          callback(null, false);
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by turning off \'Alarm\'!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
          setTimeout(function(){service.getCharacteristic(Characteristic.DialAlarm).updateValue(true);},500);
          callback(null, true);
        }
      });
    }
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Extra Characteristics // Gets
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  
  checkHASwitchState(accessory, service, type){
    const self = this;
    let homeauto = self.device.services['urn:dslforum-org:service:X_AVM-DE_Homeauto:1'];
    switch(type){
      case 'plug':
        if(!accessory.context.stopPolling){
          homeauto.actions.GetSpecificDeviceInfos([{name:'NewAIN',value:accessory.context.ain}],function(err, result) {
            if(!err){
              if(result.NewSwitchIsEnabled == 'ENABLED' && result.NewSwitchState == 'ON'){
                accessory.context.lastHASwitchstate = true;
              } else {
                accessory.context.lastHASwitchstate = false;
              }
            } else {
              self.logger.errorinfo(accessory.displayName + ': An error occured by getting ' + accessory.displayName + ' state!');
              self.logger.errorinfo(JSON.stringify(err,null,4));
            }
            service.getCharacteristic(Characteristic.On).updateValue(accessory.context.lastHASwitchstate);
            self.HATimeout = setTimeout(function(){
              self.checkHASwitchState(accessory,service,type);
            }, self.polling);
          });
        } else {
          service.getCharacteristic(Characteristic.On).updateValue(accessory.context.lastHASwitchstate);
        }
        break;
      case 'thermo':
        break;
      case 'contact':
        break;
      default:
        break;
    }
  }

  checkWifiTwo(accessory, service, callback){
    const self = this;
    let wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:1'];
    if(!accessory.context.stopPolling){
      wlan.actions.GetInfo(function(err, result) {
        if(!err){
          if(result.NewEnable == '1'){
            accessory.context.lastWifiTwoState = true;
          } else {
            accessory.context.lastWifiTwoState = false;
          }
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by getting WIFI 2.4 Ghz state!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
        }
        callback(null, accessory.context.lastWifiTwoState);
      });
    } else {
      callback(null, accessory.context.lastWifiTwoState);
    }
  }

  checkWifiFive(accessory, service, callback){
    const self = this;
    let wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:2'];
    if(!accessory.context.stopPolling){
      wlan.actions.GetInfo(function(err, result) {
        if(!err){
          if(result.NewEnable == '1'){
            accessory.context.lastWifiFiveState = true;
          } else {
            accessory.context.lastWifiFiveState = false;
          }
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by getting WIFI 5 Ghz state!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
        }
        callback(null, accessory.context.lastWifiFiveState);
      });
    } else {
      callback(null, accessory.context.lastWifiFiveState);
    }
  }

  checkWifiGuest(accessory, service, callback){
    const self = this;
    let wlan;
    if(self.device.services['urn:dslforum-org:service:WLANConfiguration:3']){
      wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:3'];
    } else {
      wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:2'];
    }
    if(!accessory.context.stopPolling){
      wlan.actions.GetInfo(function(err, result) {
        if(!err){
          if(result.NewEnable == '1'){
            accessory.context.lastWifiGuestState = true;
          } else {
            accessory.context.lastWifiGuestState = false;
          }
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by getting WIFI Guest state!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
        }
        callback(null, accessory.context.lastWifiGuestState);
      });
    } else {
      callback(null, accessory.context.lastWifiGuestState);
    }
  }

  checkWifiWPS(accessory, service, callback){
    const self = this;
    let wlan = self.device.services['urn:dslforum-org:service:WLANConfiguration:1'];
    if(!accessory.context.stopPolling){
      self.sleep(1000).then(() => {
        wlan.actions['X_AVM-DE_GetWPSInfo'](function(err, result) {
          if(!err){
            if(result['NewX_AVM-DE_WPSStatus'] == 'active'){
              accessory.context.lastWifiWPSState = true;
            } else {
              if((moment().unix()-self.wpsTimer)>=120){
                self.wpsTimer = undefined;
                self.logger.info('2 minutes are over. Turning off WIFI WPS!');
              }
              accessory.context.lastWifiWPSState = false;
            }
          } else {
            self.logger.errorinfo(accessory.displayName + ': An error occured by getting WIFI WPS state!');
            self.logger.errorinfo(JSON.stringify(err,null,4));
          }
          callback(null, accessory.context.lastWifiWPSState);
        });
      });
    } else {
      callback(null, accessory.context.lastWifiWPSState);
    }
  }

  checkAW(accessory, service, callback){
    const self = this;
    let aw = self.device.services['urn:dslforum-org:service:X_AVM-DE_TAM:1']; 
    if(!accessory.context.stopPolling){
      aw.actions.GetInfo([{name:'NewIndex',value:'0'}],function(err, result) {
        if(!err){
          if(result.NewEnable == '1'){
            accessory.context.lastAWState = true;
          } else {
            accessory.context.lastAWState = false;
          }
        } else {
          self.logger.errorinfo(accessory.displayName + ': An error occured by getting Answering Machine state!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
        }
        callback(null, accessory.context.lastAWState);
      });
    } else {
      callback(null, accessory.context.lastAWState);
    }
  }

  checkDeflection(accessory, service, callback){
    const self = this;
    let deflection = self.device.services['urn:dslforum-org:service:X_AVM-DE_OnTel:1'];
    if(!accessory.context.stopPolling){
      deflection.actions.GetNumberOfDeflections(function(err, result) {
        if(!err){
          if(result.NewNumberOfDeflections != 0){
            let deflection = self.device.services['urn:dslforum-org:service:X_AVM-DE_OnTel:1'];
            deflection.actions.GetDeflection([{name:'NewDeflectionId',value:'0'}],function(err, result) {
              if(!err){
                if(result.NewEnable == '1'){
                  accessory.context.lastDeflectiontate = true;
                } else {
                  accessory.context.lastDeflectiontate = false;
                }
              } else {
                self.logger.errorinfo(accessory.displayName + ': An error occured by getting Deflection state!');
                self.logger.errorinfo(JSON.stringify(err,null,4));
              }
              callback(null, accessory.context.lastDeflectiontate);
            });
          } else {
            callback(null, accessory.context.lastDeflectiontate);
            self.logger.warninfo('Cant check declection state, no deflections setted up in fritz.box settings!');
            accessory.context.lastDeflectiontate = false;
            self.ignorePosted = 1;
            service.getCharacteristic(Characteristic.Deflection).updateValue(accessory.context.lastDeflectiontate);
          }
        } else {
          callback(null, accessory.context.lastDeflectiontate);
          self.logger.errorinfo(accessory.displayName + ': An error occured by getting Number of Deflactions!');
          self.logger.errorinfo(JSON.stringify(err,null,4));
        }
      });

    } else {
      callback(null, accessory.context.lastDeflectiontate);
    }
  }

  getMeasurement(accessory, service){
    const self = this;
    self.logger.info('Starting broadband measurement...');
    self.speedTest({
      maxTime: accessory.context.maxTime
    })
      .on('data', data => {
        accessory.context.lastDLSpeed = data.speeds.download;
        accessory.context.lastULSpeed = data.speeds.upload;
        accessory.context.lastPing = data.server.ping;
        self.logger.info('Download: ' + accessory.context.lastDLSpeed + ' Mbps');
        self.logger.info('Upload: ' + accessory.context.lastULSpeed + ' Mbps');
        self.logger.info('Ping: ' + accessory.context.lastPing + ' ms');
        self.logger.info('Next measurement in ' + (accessory.context.broadbandPolling/60/1000) + ' minutes');
        service.getCharacteristic(Characteristic.DownloadSpeed).updateValue(accessory.context.lastDLSpeed);
        service.getCharacteristic(Characteristic.UploadSpeed).updateValue(accessory.context.lastULSpeed);
        service.getCharacteristic(Characteristic.Ping).updateValue(accessory.context.lastPing);
        setTimeout(function() {
          self.getMeasurement(accessory, service);
        }, accessory.context.broadbandPolling); //60 minutes
      })
      .on('error', err => {
        self.logger.errorinfo(accessory.displayName + ': An error occured by checking broadband');
        self.logger.errorinfo(JSON.stringify(err,null,4));
        service.getCharacteristic(Characteristic.DownloadSpeed).updateValue(accessory.context.lastDLSpeed);
        service.getCharacteristic(Characteristic.UploadSpeed).updateValue(accessory.context.lastULSpeed);
        service.getCharacteristic(Characteristic.Ping).updateValue(accessory.context.lastPing);
        setTimeout(function() {
          self.getMeasurement(accessory, service);
        }, 60 * 1000); //1minutes
      });
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // MotionSensor
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  getAnyoneMotionDetected(accessory, service){
    const self = this;
    let allAccessories = self.accessories;
    let motion = 0;
    for(const i in allAccessories){
      if(allAccessories[i].context.type == self.types.presence && allAccessories[i].displayName != 'Anyone'){
        let state = accessory.context.accType == 'motion' ? 
          allAccessories[i].getService(Service.MotionSensor).getCharacteristic(Characteristic.MotionDetected).value :
          allAccessories[i].getService(Service.OccupancySensor).getCharacteristic(Characteristic.OccupancyDetected).value;
        if(state){
          motion += 1;
        }
      }
    }
    if(motion > 0){
      accessory.context.lastMotionState = true;
    } else {
      accessory.context.lastMotionState = false;
    }
    accessory.context.accType == 'motion' ? 
      service.getCharacteristic(Characteristic.MotionDetected).updateValue(accessory.context.lastMotionState) :
      service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(accessory.context.lastMotionState);
    setTimeout(function(){self.getAnyoneMotionDetected(accessory, service);},1000);
  }

  getMotionDetected(accessory, service){
    const self = this;
    if(self.presenceTimeout)clearTimeout(self.presenceTimeout);
    let allAccessories = self.accessories;
    let repeater = [];
    let actionName;
    let actionVal;
    let adress;
    let user = self.device.services['urn:dslforum-org:service:Hosts:1'];
    if(accessory.context.mac){
      actionName = 'GetSpecificHostEntry';
      actionVal = 'NewMACAddress';
      adress = accessory.context.mac;
    } else {
      actionName = 'X_AVM-DE_GetSpecificHostEntryByIP';
      actionVal = 'NewIPAddress';
      adress = accessory.context.ip;
    }
    if(!accessory.context.stopPolling){
      user.actions[actionName]([{name:actionVal, value:adress}],function(err, result) {
        if(!err){
          self.timeoutError = 0;
          if(result.NewActive == '1'){
            accessory.context.lastMotionState = true;
            accessory.context.accType == 'motion' ? 
              service.getCharacteristic(Characteristic.MotionDetected).updateValue(accessory.context.lastMotionState) :
              service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(accessory.context.lastMotionState);
            if(self.info||self.presenceTimer){
              self.logger.info('Presence detected again for ' + accessory.displayName);
              self.info = false;
              self.presenceTimer = false;
            }
            if(!accessory.context.stopPolling){
              self.presenceTimeout = setTimeout(function(){
                self.getMotionDetected(accessory, service);
              }, self.polling);
            }
          } else { 
            for(const i in allAccessories){
              if(allAccessories[i].context.type == self.types.repeater){
                repeater.push({
                  host: allAccessories[i].context.options.host,
                  port: allAccessories[i].context.options.port,
                  username: allAccessories[i].context.options.username,
                  password: allAccessories[i].context.options.password,
                  timeout: self.platform.devOptions.timeout
                });
              }
            }
            let checkPresenceFunction = function(options, callback){
              if(!accessory.context.stopPolling){
                let tr064Repeater = new tr.TR064(options); 
                tr064Repeater.initDevice()
                  .then(result => {
                    result.startEncryptedCommunication()
                      .then(device => {
                        device.login(options.username, options.password);
                        let userRepeater = device.services['urn:dslforum-org:service:Hosts:1'];
                        userRepeater.actions[actionName]([{name:actionVal, value:adress}],function(err, res) {
                          if(!err){
                            if(res.NewActive == '1'){
                              callback(null, true);
                            } else {
                              callback(null, false);
                            }
                          } else {
                            if(err.tr064&&(err.tr064=='NoSuchEntryInArray'||err.tr064=='SpecifiedArrayIndexInvalid')){
                              callback(null, false);
                            } else {
                              callback(err, null);
                            }
                          }
                        });
                      })
                      .catch(sslerr => {
                        callback(sslerr, null);
                      });
                  })
                  .catch(err => {
                    callback(err, null);
                  });
              } else {
                callback(null, accessory.context.lastMotionState);
              }
            };
            async.concat(repeater, checkPresenceFunction, function(asyncerr, values) {
              if(!asyncerr){
                if(values.includes(true)){
                  accessory.context.lastMotionState = true;
                  if(self.info||self.presenceTimer){
                    self.logger.info('Presence detected again for ' + accessory.displayName);
                    self.info = false;
                    self.presenceTimer = false;
                  }
                } else {
                  !self.presenceTimer ? self.presenceTimer = moment().unix() : self.presenceTimer; 
                  if(accessory.context.lastMotionState&&accessory.context.delay>0&&(moment().unix()-self.presenceTimer)<=(accessory.context.delay/1000)){
                    if(!self.info){
                      self.logger.warninfo(accessory.displayName + ': No presence! Presence delay is active.');
                      self.logger.warninfo(accessory.displayName + ': Wait ' + (accessory.context.delay/1000) + ' seconds before switching to no presence');
                      self.info = true;
                    }
                  } else {
                    accessory.context.lastMotionState = false;
                    if(self.info){
                      self.logger.warninfo(accessory.displayName + ': No presence after ' + (accessory.context.delay/1000) + ' seconds');
                      self.logger.warninfo(accessory.displayName + ': Switching to no presence');
                      self.info = false;
                      self.presenceTimer = false;
                    }
                  }
                }
                self.timeoutErrorRep = 0;
                accessory.context.accType == 'motion' ? 
                  service.getCharacteristic(Characteristic.MotionDetected).updateValue(accessory.context.lastMotionState) :
                  service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(accessory.context.lastMotionState);
              } else {
                if(asyncerr.error=='ETIMEDOUT'||asyncerr.errorCode=='ETIMEDOUT'){
                  if(self.timeoutErrorRep>5){
                    self.timeoutErrorRep = 0;
                    self.logger.errorinfo(accessory.displayName + ': Connection timed out! Trying again...');
                    self.logger.errorinfo(JSON.stringify(err,null,4));
                  } else {
                    self.timeoutErrorRep += 1;
                  }
                } else {
                  self.timeoutErrorRep = 0;
                  self.logger.errorinfo(accessory.displayName + ': An error occured by getting presence state from repeater, trying again...');
                  self.logger.errorinfo(JSON.stringify(asyncerr,null,4));
                }
                accessory.context.accType == 'motion' ? 
                  service.getCharacteristic(Characteristic.MotionDetected).updateValue(accessory.context.lastMotionState) :
                  service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(accessory.context.lastMotionState);
              }
              if(!accessory.context.stopPolling){
                self.presenceTimeout = setTimeout(function(){
                  self.getMotionDetected(accessory, service);
                }, self.polling);
              }
            });
          }
        } else {
          if(err.tr064&&(err.tr064=='NoSuchEntryInArray'||err.tr064=='SpecifiedArrayIndexInvalid')){
            self.timeoutError = 0;
            !self.presenceTimer ? self.presenceTimer = moment().unix() : self.presenceTimer; 
            if(accessory.context.lastMotionState&&accessory.context.delay>0&&(moment().unix()-self.presenceTimer)<=(accessory.context.delay/1000)){
              accessory.context.lastMotionState = true;
              if(!self.info){
                self.logger.warninfo(accessory.displayName + ': No presence! Presence delay is active.');
                self.logger.warninfo(accessory.displayName + ': Wait ' + (accessory.context.delay/1000) + ' seconds before switching to no presence');
                self.info = true;
              }
            } else {
              accessory.context.lastMotionState = false;
              if(self.info){
                self.logger.warninfo(accessory.displayName + ': No presence after ' + (accessory.context.delay/1000) + ' seconds');
                self.logger.warninfo(accessory.displayName + ': Switching to no presence');
                self.info = false;
                self.presenceTimer = false;
              }
            }
          } else {
            if(err.error=='ETIMEDOUT'||err.errorCode=='ETIMEDOUT'){
              if(self.timeoutError>5){
                self.timeoutError = 0;
                self.logger.errorinfo(accessory.displayName + ': Connection timed out!');
                self.logger.errorinfo(JSON.stringify(err,null,4));
              } else {
                self.timeoutError += 1;
              }
            } else {
              self.timeoutError = 0;
              self.logger.errorinfo(accessory.displayName + ': An error occured by getting presence state from main device, trying again...');
              self.logger.errorinfo(JSON.stringify(err,null,4));
            }
          }
          accessory.context.accType == 'motion' ? 
            service.getCharacteristic(Characteristic.MotionDetected).updateValue(accessory.context.lastMotionState) :
            service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(accessory.context.lastMotionState);
          if(!accessory.context.stopPolling){
            self.presenceTimeout = setTimeout(function(){
              self.getMotionDetected(accessory, service);
            }, self.polling);
          }
        }
      });
    } else {
      accessory.context.accType == 'motion' ? 
        service.getCharacteristic(Characteristic.MotionDetected).updateValue(accessory.context.lastMotionState) :
        service.getCharacteristic(Characteristic.OccupancyDetected).updateValue(accessory.context.lastMotionState);
      self.presenceTimeout = setTimeout(function(){
        self.getMotionDetected(accessory, service);
      }, 5000);
    }
  }

  getMotionLastActivation(accessory, service){
    const self = this;
    const totallength = accessory.context.fakegatoService.history.length - 1;
    const latestTime = accessory.context.fakegatoService.history[totallength].time;
    const state = accessory.context.lastMotionState ? 1:0;
    state == 1 ? accessory.context.lastActivation = moment().unix() : accessory.context.lastActivation = latestTime - accessory.context.fakegatoService.getInitialTime();
    service.getCharacteristic(Characteristic.EveMotionLastActivation).updateValue(accessory.context.lastActivation);
    setTimeout(function(){
      self.getMotionLastActivation(accessory, service);
    }, 1000);
  }

  changeValue(accessory, service, type, subtype, value){
    const self = this;
    value.context = subtype;
    switch (type) {
      case 2:
        if(accessory.displayName != 'Anyone'){
          if(value.newValue){
            let message = 'Welcome at home ' + accessory.displayName;
            self.logger.info(message);
            if(self.platform.presenceOptions.telegram&&self.platform.presenceOptions.chatID&&self.platform.presenceOptions.token&&self.platform.presenceOptions.messages){
              if(self.platform.presenceOptions.messages.sensorOn&&self.platform.presenceOptions.messages.sensorOn != ''){
                message = self.platform.presenceOptions.messages.sensorOn;
                message = message.replace('@', accessory.displayName);
                self.sendTelegram(self.platform.presenceOptions.token,self.platform.presenceOptions.chatID,message); 
              }
            }
          } else {
            let message = 'Bye bye ' + accessory.displayName;
            self.logger.info(message);
            if(self.platform.presenceOptions.telegram&&self.platform.presenceOptions.chatID&&self.platform.presenceOptions.token&&self.platform.presenceOptions.messages){
              if(self.platform.presenceOptions.messages.sensorOff&&self.platform.presenceOptions.messages.sensorOff != ''){
                message = self.platform.presenceOptions.messages.sensorOff;
                message = message.replace('@', accessory.displayName);
                self.sendTelegram(self.platform.presenceOptions.token,self.platform.presenceOptions.chatID,message); 
              }
            }
          }
        } else {
          if(!value.newValue){
            let message = 'No one at home!';
            self.logger.info(message);
            if(self.platform.presenceOptions.telegram&&self.platform.presenceOptions.chatID&&self.platform.presenceOptions.token&&self.platform.presenceOptions.messages){
              if(self.platform.presenceOptions.messages.anyoneOff&&self.platform.presenceOptions.messages.anyoneOff != ''){
                message = self.platform.presenceOptions.messages.anyoneOff;
                self.sendTelegram(self.platform.presenceOptions.token,self.platform.presenceOptions.chatID,message);
              }
            }
          } else {
            let message = 'Presence detected at home!';
            self.logger.info(message);
            if(self.platform.presenceOptions.telegram&&self.platform.presenceOptions.chatID&&self.platform.presenceOptions.token&&self.platform.presenceOptions.messages){
              if(self.platform.presenceOptions.messages.anyoneOn&&self.platform.presenceOptions.messages.anyoneOn != ''){
                message = self.platform.presenceOptions.messages.anyoneOn;
                self.sendTelegram(self.platform.presenceOptions.token,self.platform.presenceOptions.chatID,message);
              }
            }
          }
        }
        if(accessory.context.accType == 'motion'){
          accessory.context.fakegatoService.addEntry({
            time: moment().unix(),
            status: value.newValue ? 1:0
          });
        }
        break;
      default:
        break;
    }
  }

}

module.exports = Fritz_Box;
