/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
BrowserID.State = (function() {
  "use strict";

  var bid = BrowserID,
      storage = bid.Storage,
      network = bid.Network,
      mediator = bid.Mediator,
      helpers = bid.Helpers,
      user = bid.User,
      moduleManager = bid.module,
      complete = bid.Helpers.complete;

  function startStateMachine() {
    /*jshint validthis: true*/
    // Self has been changed from a reference to this to a reference to the
    // current temporal state. State cannot be stored on the "this" object
    // because the user can go backwards in time using the "cancel_state"
    // action. If the state were stored on this object, we would not have an
    // easy way to "back up" in time. Because of this, snapshots of the
    // current state must be taken and stored every time a new state is
    // started. When a redirectToState is called, this is a continuation
    // of the current state and no new state object is stored.  When
    // a cancelState occurs, repopulate the state object with the previously
    // saved snapshot.
    var me = this,
        self = {},
        momentos = [],
        redirecting = false,
        handleState = function(msg, callback) {
          me.subscribe(msg, function(msg, info) {
            // Save a snapshot of the current state off to the momentos. If
            // a state is ever cancelled, this momento will be used as the
            // new state.
            if (shouldSaveMomento(msg)) momentos.push(_.extend({}, self));
            redirecting = false;

            callback(msg, info || {});
          });
        },
        redirectToState = function(msg, info) {
          // redirectToState is like continuing the current state.  Do not save
          // a momento if a redirection occurs.
          redirecting = true;
          mediator.publish(msg, info);
        },
        startAction = function(save, msg, options) {
          if (typeof save !== "boolean") {
            options = msg;
            msg = save;
            save = true;
          }

          var func = me.controller[msg].bind(me.controller);
          me.gotoState(save, func, options);
        },
        cancelState = function() {
          // A state has been cancelled, go back to the previous snapshot of
          // state.
          self = momentos.pop();
          me.popState();
        };

    function shouldSaveMomento(msg) {
      // Do not save temporal state machine state if we are cancelling
      // state or if we are redirecting. A redirection basically says
      // "continue the current state".  A "cancel_state" would put the
      // current state on the list of momentos which would then have to
      // immediately be taken back off.
      return msg !== "cancel_state" && !redirecting;
    }


    function handleEmailStaged(actionName, msg, info) {
      // The unverified email has been staged, now the user has to confirm
      // ownership of the address.  Send them off to the "verify your address"
      // screen.
      var actionInfo = {
        email: info.email,
        siteName: self.siteName
      };

      self.stagedEmail = info.email;

      // Keep these emails around until the user is actually staged.  If the
      // staging request is throttled, the next time set_password is called,
      // these variables are needed to know which staging function to call.
      // See issue #2258.
      self.newUserEmail = self.addEmailEmail = self.transitionNoPassword = null;

      startAction(actionName, actionInfo);
    }

    function handleEmailConfirmed(msg, info) {
      self.email = self.stagedEmail;

      if (info.mustAuth) {
        // If the mustAuth flag comes in, the user has to authenticate.
        // This is not a cancelable authentication.  mustAuth is set
        // after a user verifies an address but is not authenticated
        // to the password level.
        redirectToState("authenticate_specified_email", {
          email: self.stagedEmail,
          mustAuth: info.mustAuth,
          cancelable: !info.mustAuth
        });
      }
      else {
        redirectToState("email_chosen", { email: self.stagedEmail });
      }
    }


    /**
     * The entry point to the state machine. Users who are returning from
     * authenticating with their primary will have info.email and info.type set
     * to primary.
     */
    handleState("start", function(msg, info) {
      self.hostname = info.hostname;
      self.siteName = info.siteName || info.hostname;
      self.siteTOSPP = !!(info.privacyPolicy && info.termsOfService);

      if (info.forceIssuer) {
        user.setIssuer(info.forceIssuer);
      }

      self.allowUnverified = info.allowUnverified;
      user.setAllowUnverified(info.allowUnverified);

      startAction(false, "doRPInfo", info);

      if (info.email && info.type === "primary") {
        // this case is where a users is returning to the dialog from
        // authentication with a primary.  Elsewhere in
        // code we key off of whether .primaryVerificationInfo is
        // set to behave differently the first time the dialog is
        // loaded vs. when a user returns to the dialog after auth with
        // primary.
        self.primaryVerificationInfo = info;
        redirectToState("primary_user", info);
      }
      else {
        startAction("doCheckAuth", info);
      }
    });

    handleState("cancel", function() {
      startAction("doCancel");
    });

    handleState("window_unload", function() {
      // Round up final KPI stats as the user is leaving the dialog.  This
      // ensures the final state is sent to the KPI stats.  Any new logins are
      // counted, any new sites are counted, any new emails are included, etc.
      mediator.publish("kpi_data", {
        number_emails: storage.getEmailCount() || 0,
        number_sites_signed_in: storage.loggedInCount() || 0,
        number_sites_remembered: storage.site.count() || 0,
        orphaned: !self.success
     });
    });

    handleState("authentication_checked", function(msg, info) {
      var authenticated = info.authenticated;
      if (authenticated) {
        redirectToState("pick_email");
      } else {
        redirectToState("authenticate");
      }
      mediator.publish("user_can_interact");
    });

    handleState("authenticate", function(msg, info) {
      _.extend(info, {
        siteName: self.siteName,
        siteTOSPP: self.siteTOSPP,
        allowUnverified: self.allowUnverified
      });

      startAction("doAuthenticate", info);
    });

    handleState("authenticate_specified_email", function(msg, info) {
      // user must authenticate with their password, kick them over to
      // the required email screen to enter the password.
      startAction("doAuthenticateWithRequiredEmail", {
        email: info.email,
        secondary_auth: true,
        cancelable: ("cancelable" in info) ? info.cancelable : true,
        // This is a user is already authenticated to the assertion
        // level who has chosen a secondary email address from the
        // pick_email screen. They would have been shown the
        // siteTOSPP there.
        siteTOSPP: false
      });
      complete(info.complete);
    });

    handleState("new_user", function(msg, info) {
      self.newUserEmail = info.email;

      // Add new_account to the KPIs *before* the staging occurs allows us to
      // know when we are losing users due to the email verification.
      mediator.publish("kpi_data", { new_account: true });

      startAction(false, "doSetPassword", info);
      complete(info.complete);
    });

    handleState("transition_no_password", function(msg, info) {
      self.transitionNoPassword = info.email;
      info.transition_no_password = true;
      startAction(false, "doSetPassword", info);
      complete(info.complete);
    });

    // B2G forceIssuer on primary
    handleState("new_fxaccount", function(msg, info) {
      self.newFxAccountEmail = info.email;

      info.fxaccount = true;
      startAction(false, "doSetPassword", info);
      complete(info.complete);
    });

    handleState("password_set", function(msg, info) {
      /* A password can be set for several reasons
       * 1) This is a new user
       * 2) A user is adding the first secondary address to an account that
       * consists only of primary addresses
       * 3) an existing user has forgotten their password and wants to reset it.
       * 4) A primary address was downgraded to a secondary and the user
       *    has no password in the DB.
       * 5) RP is using forceIssuer and we have a primary email address with
       * no password for the user
       * #1 is taken care of by newUserEmail, #2 by addEmailEmail, #3 by resetPasswordEmail,
       * #4 by transitionNoPassword and #5 by fxAccountEmail
       */
      info = _.extend({ email: self.newUserEmail || self.addEmailEmail ||
                               self.resetPasswordEmail || self.transitionNoPassword ||
                               self.newFxAccountEmail}, info);
      if(self.newUserEmail) {
        startAction(false, "doStageUser", info);
      }
      else if(self.addEmailEmail) {
        startAction(false, "doStageEmail", info);
      }
      else if (self.transitionNoPassword) {
        redirectToState("stage_transition_to_secondary", info);
      }
      else if(self.newFxAccountEmail) {
        startAction(false, "doStageUser", info);
// TODO         startAction(false, "doStageResetPassword", info); ???
      }
    });

    handleState("user_staged", handleEmailStaged.curry("doConfirmUser"));

    // Once an unverified user is created, skip the confirmation step and
    // sign them in directly.
    handleState("unverified_created", function(msg, info) {
      startAction(false, "doAuthenticateWithUnverifiedEmail", info);
    });

    handleState("user_confirmed", handleEmailConfirmed);

    handleState("stage_transition_to_secondary", function(msg, info) {
      startAction(false, "doStageTransitionToSecondary", info);
    });

    handleState("transition_to_secondary_staged", handleEmailStaged.curry("doConfirmTransitionToSecondary"));

    handleState("transition_to_secondary_confirmed", handleEmailConfirmed);

    handleState("upgraded_primary_user", function (msg, info) {
      user.usedAddressAsPrimary(info.email, function () {
        info.state = 'known';
        redirectToState("email_chosen", info);
      }, info.complete);
    });

    handleState("primary_user", function(msg, info) {
      self.addPrimaryUser = !!info.add;
      var email = self.email = info.email,
          idInfo = storage.getEmail(email);

      if (idInfo && idInfo.cert) {
        redirectToState("primary_user_ready", info);
      }
      else {
        user.isEmailRegistered(email, function(known) {
          if (!known) {
            mediator.publish("kpi_data", { new_account: true });
          }
        });

        // We don't want to put the provisioning step on the stack,
        // instead when a user cancels this step, they should go
        // back to the step before the provisioning.
        startAction(false, "doProvisionPrimaryUser", info);
      }
    });

    handleState("primary_user_provisioned", function(msg, info) {
      // The user is is authenticated with their IdP. Two possibilities exist
      // for the email - 1) create a new account or 2) add address to the
      // existing account. If the user is authenticated with Persona, #2
      // will happen. If not, #1.
      info = info || {};
      info.add = !!self.addPrimaryUser;
      startAction("doPrimaryUserProvisioned", info);
    });

    handleState("primary_user_unauthenticated", function(msg, info) {
      /*jshint newcap:false*/
      _.extend(info, {
        add: !!self.addPrimaryUser,
        email: self.email,
        siteName: self.siteName,
        idpName: info.idpName || URLParse(info.auth_url).host
      });

      // If .primaryVerificationInfo is set, that means the user is
      // returning to the dialog after authentication with their IdP.
      // When provisioning fails and:
      // 1. it's the first provisioning attempt - we send the user to
      //    authentication with their IdP
      // 2. it's the second provisioning attempt - we sent the user back
      //    to the proper screen to pick a new email address.
      // related to issue #2339
      if (self.primaryVerificationInfo) {
        self.primaryVerificationInfo = null;
        if (info.add) {
          // Add the pick_email in case the user cancels the add_email screen.
          // The user needs something to go "back" to.
          redirectToState("pick_email");
          redirectToState("add_email", info);
        }
        else {
          redirectToState("authenticate", info);
        }
      }
      else {
        startAction("doVerifyPrimaryUser", info);
        complete(info.complete);
      }
    });

    handleState("primary_user_authenticating", function(msg, info) {
      // Keep the dialog from automatically closing when the user browses to
      // the IdP for verification.
      moduleManager.stopAll();
      me.success = self.success = true;
    });

    handleState("primary_user_ready", function(msg, info) {
      // redirect to email_chosen, which is more a general codepath,
      // ensure that it knows that this is a primary email address.
      _.extend(info, { type: "primary" });
      redirectToState("email_chosen", info);
    });

    handleState("primary_offline", function(msg, info) {
      startAction("doPrimaryOffline", info);
    });

    handleState("pick_email", function() {
      startAction("doPickEmail", {
        origin: self.hostname,
        siteTOSPP: self.siteTOSPP && !user.getOriginEmail()
      });
    });

    handleState("email_chosen", function(msg, info) {
      var email = info.email,
          record = user.getStoredEmailKeypair(email);

      self.email = email;

      function oncomplete() {
        complete(info.complete);
      }

      if (!record) {
        throw new Error("invalid email");
      }

      mediator.publish("kpi_data", { email_type: info.type });

      if ('offline' === info.state) {
        redirectToState("primary_offline", info);
      }
      else if (info.type === "primary") {

        if (record.cert) {
          // Email is a primary and the cert is available - the user can log
          // in without authenticating with the IdP. All invalid/expired
          // certs are assumed to have been checked and removed by this
          // point.
          redirectToState("email_valid_and_ready", info);
        } else if ("transition_to_primary" === info.state) {
          startAction("doUpgradeToPrimaryUser", info);
          complete(info.complete);
        }
        else {
          // If the email is a primary and the cert is not available,
          // throw the user down the primary flow. The primary flow will
          // catch cases where the primary certificate is expired
          // and the user must re-verify with their IdP.
          redirectToState("primary_user", info);
        }
      }
      else if (!user.isDefaultIssuer() && !record.cert) {
        // TODO: Duplicates some of the logic in the authentication action module.
        user.resetCaches();
        user.addressInfo(info.email, function (serverInfo) {
          // We'll end up in this state again, but we want to see serverInfo.state change
          if (serverInfo.state === "transition_no_password") {
            var newInfo = _.extend(info, { fxaccount: true });
            self.newFxAccountEmail = info.email;
            startAction(false, "doSetPassword", info);
          } else {
            redirectToState("email_valid_and_ready", info);
            oncomplete();
          }
        }, function () {
          throw new Error('Unable to check with address info from email_chosen');
        });
      }
      // Anything below this point means the address is a secondary.
      else if ("transition_to_secondary" === info.state) {
        startAction("doAuthenticate", info);
      }
      else if ("transition_no_password" === info.state) {
        redirectToState("transition_no_password", info);
      }
      else if (info.state === 'unverified' && !self.allowUnverified) {
        // user selected an unverified secondary email, kick them over to the
        // verify screen.
        redirectToState("stage_reverify_email", info);
      }
      else {
        // make sure an unverified-certs are removed
        if (record.unverified && info.state !== 'unverified') {
          storage.invalidateEmail(email, user.getIssuer());
        }


        // Address is verified, check the authentication, if the user is not
        // authenticated to the assertion level, force them to enter their
        // password.
        user.checkAuthentication(function(authentication) {
          if (authentication === "assertion") {
             // user must authenticate with their password, kick them over to
            // the required email screen to enter the password.
            redirectToState("authenticate_specified_email", info);
          }
          else {
            redirectToState("email_valid_and_ready", info);
            oncomplete();
          }
        }, oncomplete);
      }
    });

    handleState("stage_reverify_email", function(msg, info) {
      // A user has selected an email that has not been verified after
      // a password reset.  Stage the email again to be re-verified.
      var actionInfo = {
        email: info.email
      };
      startAction("doStageReverifyEmail", actionInfo);
    });

    handleState("reverify_email_staged", handleEmailStaged.curry("doConfirmReverifyEmail"));

    handleState("reverify_email_confirmed", handleEmailConfirmed);

    handleState("email_valid_and_ready", function(msg, info) {
      // this state is only called after all checking is done on the email
      // address.  For secondaries, this means the email has been validated and
      // the user is authenticated to the password level.  For primaries, this
      // means the user is authenticated with their IdP and the certificate for
      // the address is valid.  An assertion can be generated, but first we
      // may have to check whether the user owns the computer.
      user.shouldAskIfUsersComputer(function(shouldAsk) {
        if (shouldAsk) {
          redirectToState("is_this_your_computer", info);
        }
        else {
          redirectToState("generate_assertion", info);
        }
      });
    });

    handleState("is_this_your_computer", function(msg, info) {
      // We have to confirm the user's computer ownership status.  Save off
      // the selected email info for when the user_computer_status_set is
      // complete so that the user can continue the flow with the correct
      // email address.
      self.chosenEmailInfo = info;
      startAction("doIsThisYourComputer", info);
    });

    handleState("user_computer_status_set", function(msg, info) {
      // User's status has been confirmed, an assertion can safely be
      // generated as there are no more delays introduced by user interaction.
      // Use the email address that was stored in the call to
      // "is_this_your_computer".
      var emailInfo = self.chosenEmailInfo;
      self.chosenEmailInfo = null;
      redirectToState("generate_assertion", emailInfo);
    });

    handleState("generate_assertion", function(msg, info) {
      startAction("doGenerateAssertion", info);
    });

    handleState("forgot_password", function(msg, info) {
      // User has forgotten their password, let them reset it.  The user will
      // be transitioned to the confirmation screen and must verify their email
      // address. The new password will be entered on the main site after the
      // user verifies their address.
      startAction(false, "doStageResetPassword", info);
      complete(info.complete);
    });

    handleState("reset_password_staged", handleEmailStaged.curry("doConfirmResetPassword"));

    handleState("assertion_generated", function(msg, info) {
      self.success = true;
      if (info.assertion !== null) {
        storage.site.set(user.getOrigin(), "logged_in", self.email);

        startAction("doAssertionGenerated", { assertion: info.assertion, email: self.email });
      }
      else {
        redirectToState("pick_email");
      }
    });

    handleState("reset_password_confirmed", handleEmailConfirmed);

    handleState("notme", function() {
      startAction("doNotMe");
    });

    handleState("logged_out", function() {
      redirectToState("authenticate");
    });

    handleState("authenticated", function(msg, info) {
      redirectToState("email_chosen", info);
    });

    handleState("add_email", function(msg, info) {
      // add_email indicates the user wishes to add an email to the account,
      // the add_email screen must be displayed.  After the user enters the
      // email address they wish to add, add_email will trigger
      // either 1) primary_user or 2) email_staged. #1 occurs if the email
      // address is a primary address, #2 occurs if the address is a secondary
      // and the verification email has been sent.
      startAction("doAddEmail", info);
    });

    handleState("stage_email", function(msg, info) {
      user.passwordNeededToAddSecondaryEmail(function(passwordNeeded) {
        if(passwordNeeded) {
          self.addEmailEmail = info.email;
          startAction(false, "doSetPassword", info);
        }
        else {
          startAction(false, "doStageEmail", info);
        }

        complete(info.complete);
      });
    });

    handleState("email_staged", handleEmailStaged.curry("doConfirmEmail"));

    handleState("email_confirmed", handleEmailConfirmed);

    handleState("cancel_state", function(msg, info) {
      cancelState(info);
    });

  }

  var State = BrowserID.StateMachine.extend({
    start: function(options) {
      var self=this;

      options = options || {};

      self.controller = options.controller;
      if (!self.controller) {
        throw new Error("start: controller must be specified");
      }

      State.sc.start.call(self, options);
      startStateMachine.call(self);
    }
  });

  return State;
}());

